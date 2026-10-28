import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VrmClient } from '../vrm/client.js';
import { VrmApiError } from '../vrm/client.js';
import { outputSchemas } from './output_schemas.js';
import {
  READ_ONLY_ANNOTATIONS,
  assertSiteAllowed,
  formatVrmError,
  idSiteSchema,
  instanceSchema,
  resolveAuth,
  sitePath,
} from './helpers.js';
import { formatNumber, formatTimestamp, parseSeries, type SeriesSample } from './present.js';

/**
 * Read-only cell-voltage spread. Discovery is GET /diagnostics (attribute
 * codes mcV / McV). The windowed min, max, and simultaneous spread come from
 * GET /widgets/Graph for those same codes. Nothing here writes.
 */

const MIN_CODES = new Set(['mcV']);
const MAX_CODES = new Set(['McV']);
const SOC_CODES = new Set(['SOC', 'bs']);
const PAGE_SIZE = 1000;
const MAX_PAGES = 20;
const ALIGN_TOLERANCE_SEC = 120;

export interface DiagnosticRecord {
  id?: number;
  timestamp?: number;
  Device?: string;
  instance?: number;
  idDataAttribute?: number;
  description?: string;
  dbusPath?: string | null;
  code?: string;
  formattedValue?: unknown;
  rawValue?: unknown;
  [k: string]: unknown;
}

export interface DiagnosticsCollection {
  records: DiagnosticRecord[];
  truncated: boolean;
  reportedTotal: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDiagnosticEntry(value: unknown): value is DiagnosticRecord {
  if (!isObject(value)) {
    return false;
  }
  return 'code' in value || 'idDataAttribute' in value || 'rawValue' in value || 'dbusPath' in value;
}

export function coerceDiagnosticRecords(records: unknown): DiagnosticRecord[] {
  if (Array.isArray(records)) {
    return records.filter(isDiagnosticEntry);
  }
  if (isDiagnosticEntry(records)) {
    return [records];
  }
  return [];
}

function entrySignature(record: DiagnosticRecord): string {
  return `${record.id ?? ''}|${record.code ?? ''}|${record.instance ?? ''}|${record.timestamp ?? ''}|${record.dbusPath ?? ''}`;
}

export async function collectDiagnostics(
  fetchPage: (page: number, count: number) => Promise<unknown>,
  opts?: { pageSize?: number; maxPages?: number },
): Promise<DiagnosticsCollection> {
  const pageSize = opts?.pageSize ?? PAGE_SIZE;
  const maxPages = opts?.maxPages ?? MAX_PAGES;
  const records: DiagnosticRecord[] = [];
  let reportedTotal: number | null = null;
  let truncated = false;
  let previousSignature: string | undefined;

  for (let page = 1; page <= maxPages; page++) {
    const body = (await fetchPage(page, pageSize)) as { records?: unknown; num_records?: unknown };
    if (typeof body?.num_records === 'number') {
      reportedTotal = body.num_records;
    } else if (typeof body?.num_records === 'string' && body.num_records.trim() !== '' && Number.isFinite(Number(body.num_records))) {
      reportedTotal = Number(body.num_records);
    }
    const batch = coerceDiagnosticRecords(body?.records);
    if (batch.length === 0) {
      break;
    }
    const signature = entrySignature(batch[0]!);
    if (signature === previousSignature) {
      truncated = reportedTotal !== null && records.length < reportedTotal;
      break;
    }
    previousSignature = signature;
    records.push(...batch);
    if (reportedTotal !== null && records.length >= reportedTotal) {
      break;
    }
    const shortPage = batch.length < pageSize;
    if (shortPage && (reportedTotal === null || records.length >= reportedTotal)) {
      break;
    }
    if (page === maxPages) {
      truncated = reportedTotal === null || records.length < reportedTotal;
    }
  }

  return { records, truncated, reportedTotal };
}

export function numericValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.trim().match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
  if (!match) {
    return null;
  }
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

function pathIsCurrentCell(path: string | null | undefined, kind: 'min' | 'max'): boolean {
  if (!path || path.toLowerCase().includes('history')) {
    return false;
  }
  const needle = kind === 'min' ? 'mincellvoltage' : 'maxcellvoltage';
  return path.toLowerCase().includes(needle);
}

function cellKind(record: DiagnosticRecord): 'min' | 'max' | null {
  const code = record.code ?? '';
  if (MIN_CODES.has(code) || pathIsCurrentCell(record.dbusPath, 'min') || record.description === 'Minimum cell voltage') {
    return 'min';
  }
  if (MAX_CODES.has(code) || pathIsCurrentCell(record.dbusPath, 'max') || record.description === 'Maximum cell voltage') {
    return 'max';
  }
  return null;
}

function isSoc(record: DiagnosticRecord): boolean {
  const code = record.code ?? '';
  if (SOC_CODES.has(code)) {
    return true;
  }
  const path = record.dbusPath ?? '';
  return path === '/Soc' || path.endsWith('/Soc');
}

interface Snapshot {
  value: number | null;
  formatted: string | null;
  timestamp: number | null;
  device: string | null;
  code: string | null;
  instance: number;
}

function snapshot(record: DiagnosticRecord): Snapshot {
  const formatted = typeof record.formattedValue === 'string' ? record.formattedValue : null;
  return {
    value: numericValue(record.rawValue) ?? numericValue(record['value']) ?? numericValue(record.formattedValue),
    formatted,
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : null,
    device: typeof record.Device === 'string' ? record.Device : null,
    code: record.code ?? null,
    instance: typeof record.instance === 'number' ? record.instance : -1,
  };
}

export interface BatteryGroup {
  instance: number;
  device: string | null;
  min: Snapshot | null;
  max: Snapshot | null;
  soc: Snapshot | null;
}

export function groupCellBatteries(records: DiagnosticRecord[], instanceFilter?: number): BatteryGroup[] {
  const byInstance = new Map<number, BatteryGroup>();
  const socRows: DiagnosticRecord[] = [];

  for (const record of records) {
    if (typeof record.instance !== 'number' || !Number.isInteger(record.instance)) {
      continue;
    }
    if (instanceFilter !== undefined && record.instance !== instanceFilter) {
      continue;
    }
    const kind = cellKind(record);
    if (kind) {
      const group = byInstance.get(record.instance) ?? {
        instance: record.instance,
        device: null,
        min: null,
        max: null,
        soc: null,
      };
      const shot = snapshot(record);
      const current = kind === 'min' ? group.min : group.max;
      const newer = current === null || (shot.timestamp ?? 0) >= (current.timestamp ?? 0);
      if (newer) {
        if (kind === 'min') {
          group.min = shot;
        } else {
          group.max = shot;
        }
        if (shot.device) {
          group.device = shot.device;
        }
      }
      byInstance.set(record.instance, group);
      continue;
    }
    if (isSoc(record)) {
      socRows.push(record);
    }
  }

  for (const group of byInstance.values()) {
    const pool = socRows.filter((row) => row.instance === group.instance);
    let best: DiagnosticRecord | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const row of pool) {
      const value = numericValue(row.rawValue) ?? numericValue(row['value']) ?? numericValue(row.formattedValue);
      if (value === null) {
        continue;
      }
      const sameInstance = row.instance === group.instance ? 0 : 10;
      const codeScore = row.code === 'SOC' ? 0 : row.code === 'bs' ? 1 : 2;
      const score = sameInstance + codeScore;
      if (score < bestScore) {
        best = row;
        bestScore = score;
      }
    }
    group.soc = best ? snapshot(best) : null;
  }

  return [...byInstance.values()].sort((a, b) => a.instance - b.instance);
}

export function spreadMillivolts(deltaVolts: number): number {
  return Math.round(deltaVolts * 1000 * 10) / 10;
}

function toSeconds(ts: number): number {
  return ts > 1e12 ? ts / 1000 : ts;
}

export function largestSimultaneousSpread(
  minSeries: SeriesSample[],
  maxSeries: SeriesSample[],
): { spreadMv: number | null; at: number | null; aligned: number } {
  if (minSeries.length === 0 || maxSeries.length === 0) {
    return { spreadMv: null, at: null, aligned: 0 };
  }
  const maxByTs = new Map<number, SeriesSample>();
  for (const sample of maxSeries) {
    maxByTs.set(sample.ts, sample);
  }
  let best: { delta: number; ts: number } | null = null;
  let aligned = 0;
  const consider = (delta: number, ts: number) => {
    aligned += 1;
    if (!best || delta > best.delta) {
      best = { delta, ts };
    }
  };
  for (const sample of minSeries) {
    const match = maxByTs.get(sample.ts);
    if (match) {
      consider(match.value - sample.value, sample.ts);
    }
  }
  if (aligned === 0) {
    const maxSorted = [...maxSeries].sort((a, b) => a.ts - b.ts);
    let j = 0;
    for (const sample of [...minSeries].sort((a, b) => a.ts - b.ts)) {
      while (
        j + 1 < maxSorted.length &&
        Math.abs(toSeconds(maxSorted[j + 1]!.ts) - toSeconds(sample.ts)) <=
          Math.abs(toSeconds(maxSorted[j]!.ts) - toSeconds(sample.ts))
      ) {
        j += 1;
      }
      const partner = maxSorted[j]!;
      if (Math.abs(toSeconds(partner.ts) - toSeconds(sample.ts)) <= ALIGN_TOLERANCE_SEC) {
        consider(partner.value - sample.value, sample.ts);
      }
    }
  }
  if (!best) {
    return { spreadMv: null, at: null, aligned: 0 };
  }
  const winner: { delta: number; ts: number } = best;
  return { spreadMv: spreadMillivolts(winner.delta), at: winner.ts, aligned };
}

export interface SpreadResult {
  minCellVoltageV: number | null;
  minCellVoltageAt: number | null;
  maxCellVoltageV: number | null;
  maxCellVoltageAt: number | null;
  spreadMv: number | null;
  largestSimultaneousSpreadMv: number | null;
  largestSimultaneousSpreadAt: number | null;
  alignedSamples: number;
  seriesSamples: { min: number; max: number };
  source: 'graph' | 'diagnostics';
}

export function computeSpread(minSeries: SeriesSample[], maxSeries: SeriesSample[], latestMin: number | null, latestMax: number | null): SpreadResult {
  const seriesSamples = { min: minSeries.length, max: maxSeries.length };
  if (minSeries.length > 0 || maxSeries.length > 0) {
    let minSample: SeriesSample | null = null;
    for (const sample of minSeries) {
      if (!minSample || sample.low < minSample.low) {
        minSample = sample;
      }
    }
    let maxSample: SeriesSample | null = null;
    for (const sample of maxSeries) {
      if (!maxSample || sample.high > maxSample.high) {
        maxSample = sample;
      }
    }
    const minV = minSample ? minSample.low : latestMin;
    const maxV = maxSample ? maxSample.high : latestMax;
    const simultaneous = largestSimultaneousSpread(minSeries, maxSeries);
    return {
      minCellVoltageV: minV,
      minCellVoltageAt: minSample ? minSample.ts : null,
      maxCellVoltageV: maxV,
      maxCellVoltageAt: maxSample ? maxSample.ts : null,
      spreadMv: minV !== null && maxV !== null ? spreadMillivolts(maxV - minV) : null,
      largestSimultaneousSpreadMv: simultaneous.spreadMv,
      largestSimultaneousSpreadAt: simultaneous.at,
      alignedSamples: simultaneous.aligned,
      seriesSamples,
      source: 'graph',
    };
  }
  const spread = latestMin !== null && latestMax !== null ? spreadMillivolts(latestMax - latestMin) : null;
  return {
    minCellVoltageV: latestMin,
    minCellVoltageAt: null,
    maxCellVoltageV: latestMax,
    maxCellVoltageAt: null,
    spreadMv: spread,
    largestSimultaneousSpreadMv: spread,
    largestSimultaneousSpreadAt: null,
    alignedSamples: spread === null ? 0 : 1,
    seriesSamples,
    source: 'diagnostics',
  };
}

interface GraphPayload {
  records?: {
    data?: Record<string, unknown>;
    meta?: Record<string, { code?: string }>;
  };
}

export function seriesForCode(payload: GraphPayload, code: string): SeriesSample[] {
  const data = payload.records?.data ?? {};
  const meta = payload.records?.meta ?? {};
  const samples: SeriesSample[] = [];
  for (const [key, points] of Object.entries(data)) {
    const seriesCode = meta[key]?.code ?? key;
    if (seriesCode !== code) {
      continue;
    }
    samples.push(...parseSeries(points));
  }
  return samples;
}

function fmtVolts(value: number | null): string {
  return value === null ? 'n/a' : `${formatNumber(value)} V`;
}

function fmtMv(value: number | null): string {
  return value === null ? 'n/a' : `${formatNumber(value)} mV`;
}

function fmtAt(ts: number | null): string {
  return ts === null ? '' : ` at ${formatTimestamp(ts)}`;
}

export interface BatterySpreadRow {
  instance: number;
  device: string | null;
  minCellVoltageV: number | null;
  minCellVoltageAt: number | null;
  maxCellVoltageV: number | null;
  maxCellVoltageAt: number | null;
  spreadMv: number | null;
  largestSimultaneousSpreadMv: number | null;
  largestSimultaneousSpreadAt: number | null;
  alignedSamples: number;
  seriesSamples: { min: number; max: number };
  source: 'graph' | 'diagnostics';
  latestMinCellVoltageV: number | null;
  latestMaxCellVoltageV: number | null;
  latestSpreadMv: number | null;
  latestTimestamp: number | null;
  soc: number | null;
  socFormatted: string | null;
  socCode: string | null;
  socInstance: number | null;
  graphError?: string;
}

export function formatBatterySpreadText(summary: {
  idSite: number;
  hours: number;
  batteries: BatterySpreadRow[];
  diagnosticsRecords: number;
  truncated: boolean;
}): string {
  const lines = [
    `# Battery cell spread — site ${summary.idSite} — last ${summary.hours} h`,
    '',
    `Diagnostics rows scanned: ${summary.diagnosticsRecords}${summary.truncated ? ' (truncated)' : ''}`,
    `Batteries with cell-voltage attributes: ${summary.batteries.length}`,
  ];
  if (summary.batteries.length === 0) {
    lines.push('', 'No mcV/McV (minimum/maximum cell voltage) attributes were found in diagnostics.');
    return lines.join('\n');
  }
  const ordered = [...summary.batteries].sort((a, b) => {
    const av = a.largestSimultaneousSpreadMv ?? a.spreadMv ?? -1;
    const bv = b.largestSimultaneousSpreadMv ?? b.spreadMv ?? -1;
    return bv - av;
  });
  for (const battery of ordered) {
    const name = battery.device ? ` — ${battery.device}` : '';
    lines.push('', `## instance ${battery.instance}${name}`);
    lines.push(`- max cell voltage: ${fmtVolts(battery.maxCellVoltageV)}${fmtAt(battery.maxCellVoltageAt)}`);
    lines.push(`- min cell voltage: ${fmtVolts(battery.minCellVoltageV)}${fmtAt(battery.minCellVoltageAt)}`);
    lines.push(`- spread: ${fmtMv(battery.spreadMv)} (envelope over the window)`);
    lines.push(
      `- largest simultaneous spread: ${fmtMv(battery.largestSimultaneousSpreadMv)}${fmtAt(battery.largestSimultaneousSpreadAt)} (${battery.alignedSamples} aligned sample(s))`,
    );
    const socText =
      battery.soc === null
        ? 'n/a'
        : `${battery.socFormatted ?? `${formatNumber(battery.soc)} %`} (code ${battery.socCode ?? '?'}, instance ${battery.socInstance ?? '?'})`;
    lines.push(`- latest SOC: ${socText}`);
    lines.push(
      `- latest snapshot: min ${fmtVolts(battery.latestMinCellVoltageV)}, max ${fmtVolts(battery.latestMaxCellVoltageV)}, spread ${fmtMv(battery.latestSpreadMv)}`,
    );
    lines.push(`- source: ${battery.source}; graph samples min=${battery.seriesSamples.min} max=${battery.seriesSamples.max}`);
    if (battery.graphError) {
      lines.push(`- graph: ${battery.graphError}`);
    }
  }
  return lines.join('\n');
}

async function loadGraph(
  client: VrmClient,
  idSite: number,
  instance: number,
  start: number,
  end: number,
): Promise<GraphPayload> {
  return client.get<GraphPayload>(sitePath(idSite, 'widgets/Graph'), {
    instance,
    start,
    end,
    'attributeCodes[]': ['mcV', 'McV'],
  });
}

export function registerBatteryTools(server: McpServer): void {
  server.registerTool(
    'vrm_battery_cell_spread',
    {
      title: 'Battery cell voltage spread',
      description:
        'Read-only cell-voltage spread for one installation over a recent window (default 24 h). ' +
        'Finds battery instances that report minimum and maximum cell voltage (codes mcV and McV, including CAN-bus BMS instances such as 512) via GET /installations/{idSite}/diagnostics, ' +
        'then reads those attributes from GET /installations/{idSite}/widgets/Graph. ' +
        'Returns each battery\'s max cell voltage, min cell voltage, envelope spread in mV, the largest simultaneous (McV−mcV) spread, and the latest state of charge. GET only.',
      inputSchema: {
        idSite: idSiteSchema,
        hours: z
          .number()
          .int()
          .min(1)
          .max(744)
          .optional()
          .describe('Look-back window in hours (default 24, max 744).'),
        instance: instanceSchema
          .optional()
          .describe('Only this device instance. Omit to include every battery that reports mcV/McV. CAN-bus BMS instances such as 512 are valid.'),
      },
      outputSchema: outputSchemas.batteryCellSpread,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ idSite, hours, instance }, extra) => {
      const auth = resolveAuth(extra);
      if (!auth.ok) {
        return auth.error;
      }
      try {
        assertSiteAllowed(idSite);
        const windowHours = hours ?? 24;
        const end = Math.floor(Date.now() / 1000);
        const start = end - windowHours * 3600;
        const collected = await collectDiagnostics((page, count) =>
          auth.client.get(sitePath(idSite, 'diagnostics'), { page, count }),
        );
        const groups = groupCellBatteries(collected.records, instance);
        const batteries: BatterySpreadRow[] = [];
        for (const group of groups) {
          const latestMin = group.min?.value ?? null;
          const latestMax = group.max?.value ?? null;
          const latestSpread = latestMin !== null && latestMax !== null ? spreadMillivolts(latestMax - latestMin) : null;
          const latestTimestamp = Math.max(group.min?.timestamp ?? 0, group.max?.timestamp ?? 0) || null;
          let spread = computeSpread([], [], latestMin, latestMax);
          let graphError: string | undefined;
          try {
            const graph = await loadGraph(auth.client, idSite, group.instance, start, end);
            spread = computeSpread(seriesForCode(graph, 'mcV'), seriesForCode(graph, 'McV'), latestMin, latestMax);
          } catch (error) {
            graphError = error instanceof VrmApiError ? `VRM API ${error.status}` : error instanceof Error ? error.message : String(error);
          }
          batteries.push({
            instance: group.instance,
            device: group.device,
            ...spread,
            latestMinCellVoltageV: latestMin,
            latestMaxCellVoltageV: latestMax,
            latestSpreadMv: latestSpread,
            latestTimestamp,
            soc: group.soc?.value ?? null,
            socFormatted: group.soc?.formatted ?? null,
            socCode: group.soc?.code ?? null,
            socInstance: group.soc ? group.soc.instance : null,
            ...(graphError ? { graphError } : {}),
          });
        }
        const summary = {
          success: true as const,
          idSite,
          hours: windowHours,
          start,
          end,
          diagnosticsRecords: collected.records.length,
          truncated: collected.truncated,
          batteries,
        };
        return {
          content: [{ type: 'text', text: formatBatterySpreadText(summary) }],
          structuredContent: summary,
        };
      } catch (error) {
        return formatVrmError(error, {
          hint: ' Cell spread calls GET /installations/{idSite}/diagnostics. The public demo token is not allowed to read it (403); a token with access to the installation can.',
        });
      }
    },
  );
}
