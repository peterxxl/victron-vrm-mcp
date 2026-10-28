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
import { lookupSiteTimeZone } from './site_time.js';

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

function isBatteryVoltage(record: DiagnosticRecord): boolean {
  const code = record.code ?? '';
  if (code === 'V' || code === 'bv') {
    return true;
  }
  const path = (record.dbusPath ?? '').toLowerCase();
  return path.endsWith('/dc/0/voltage');
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
  voltage: Snapshot | null;
}

export function groupCellBatteries(records: DiagnosticRecord[], instanceFilter?: number): BatteryGroup[] {
  const byInstance = new Map<number, BatteryGroup>();
  const socRows: DiagnosticRecord[] = [];
  const voltageRows: DiagnosticRecord[] = [];

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
        voltage: null,
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
      continue;
    }
    if (isBatteryVoltage(record)) {
      voltageRows.push(record);
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
    const voltages = voltageRows.filter((row) => row.instance === group.instance);
    let bestVoltage: DiagnosticRecord | null = null;
    let bestVoltageScore = Number.POSITIVE_INFINITY;
    for (const row of voltages) {
      if (snapshot(row).value === null) {
        continue;
      }
      const codeScore = row.code === 'V' ? 0 : row.code === 'bv' ? 1 : 2;
      const ts = typeof row.timestamp === 'number' ? row.timestamp : 0;
      const score = codeScore * 1e15 - ts;
      if (score < bestVoltageScore) {
        bestVoltage = row;
        bestVoltageScore = score;
      }
    }
    group.voltage = bestVoltage ? snapshot(bestVoltage) : null;
  }

  return [...byInstance.values()].sort((a, b) => a.instance - b.instance);
}

export function spreadMillivolts(deltaVolts: number): number {
  return Math.round(deltaVolts * 1000 * 10) / 10;
}

function toSeconds(ts: number): number {
  return ts > 1e12 ? ts / 1000 : ts;
}

export function medianStepSeconds(samples: SeriesSample[]): number | null {
  if (samples.length < 2) {
    return null;
  }
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);
  const steps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const delta = toSeconds(sorted[i]!.ts) - toSeconds(sorted[i - 1]!.ts);
    if (delta > 0) {
      steps.push(delta);
    }
  }
  if (steps.length === 0) {
    return null;
  }
  steps.sort((a, b) => a - b);
  const mid = Math.floor(steps.length / 2);
  const median = steps.length % 2 === 1 ? steps[mid]! : (steps[mid - 1]! + steps[mid]!) / 2;
  return Math.round(median);
}

interface AlignedSpread {
  spreadMv: number | null;
  at: number | null;
  aligned: number;
  minCellId: string | null;
  maxCellId: string | null;
}

export function largestSimultaneousSpread(minSeries: SeriesSample[], maxSeries: SeriesSample[]): AlignedSpread {
  const empty: AlignedSpread = { spreadMv: null, at: null, aligned: 0, minCellId: null, maxCellId: null };
  if (minSeries.length === 0 || maxSeries.length === 0) {
    return empty;
  }
  const maxByTs = new Map<number, SeriesSample>();
  for (const sample of maxSeries) {
    maxByTs.set(sample.ts, sample);
  }
  let best: { delta: number; ts: number; minCellId: string | null; maxCellId: string | null } | null = null;
  let aligned = 0;
  const consider = (minSample: SeriesSample, maxSample: SeriesSample, ts: number) => {
    // Bucket min of mcV against bucket max of McV. Inside a wide bucket those
    // extremes are not necessarily the same instant.
    const delta = maxSample.high - minSample.low;
    aligned += 1;
    if (!best || delta > best.delta) {
      best = { delta, ts, minCellId: minSample.cellId, maxCellId: maxSample.cellId };
    }
  };
  for (const sample of minSeries) {
    const match = maxByTs.get(sample.ts);
    if (match) {
      consider(sample, match, sample.ts);
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
        consider(sample, partner, sample.ts);
      }
    }
  }
  if (!best) {
    return empty;
  }
  const winner: { delta: number; ts: number; minCellId: string | null; maxCellId: string | null } = best;
  return {
    spreadMv: spreadMillivolts(winner.delta),
    at: winner.ts,
    aligned,
    minCellId: winner.minCellId,
    maxCellId: winner.maxCellId,
  };
}

export function voltageAt(series: SeriesSample[], ts: number, toleranceSec = ALIGN_TOLERANCE_SEC): number | null {
  if (series.length === 0) {
    return null;
  }
  const exact = series.find((sample) => sample.ts === ts);
  if (exact) {
    return exact.value;
  }
  let best: SeriesSample | null = null;
  let bestDt = Number.POSITIVE_INFINITY;
  for (const sample of series) {
    const dt = Math.abs(toSeconds(sample.ts) - toSeconds(ts));
    if (dt < bestDt) {
      best = sample;
      bestDt = dt;
    }
  }
  if (!best || bestDt > toleranceSec) {
    return null;
  }
  return best.value;
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
  bucketSeconds: number | null;
  simultaneousSpreadUpperBound: boolean;
  minCellId: string | null;
  maxCellId: string | null;
  worstMinCellId: string | null;
  worstMaxCellId: string | null;
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
    const bucketSeconds = medianStepSeconds(minSeries.length >= 2 ? minSeries : maxSeries);
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
      bucketSeconds,
      simultaneousSpreadUpperBound: bucketSeconds !== null && bucketSeconds > 60,
      minCellId: minSample?.cellId ?? null,
      maxCellId: maxSample?.cellId ?? null,
      worstMinCellId: simultaneous.minCellId,
      worstMaxCellId: simultaneous.maxCellId,
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
    bucketSeconds: null,
    simultaneousSpreadUpperBound: false,
    minCellId: null,
    maxCellId: null,
    worstMinCellId: null,
    worstMaxCellId: null,
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

function fmtAt(ts: number | null, timeZone?: string | null): string {
  return ts === null ? '' : ` at ${formatTimestamp(ts, timeZone)}`;
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
  bucketSeconds: number | null;
  simultaneousSpreadUpperBound: boolean;
  minCellId: string | null;
  maxCellId: string | null;
  worstMinCellId: string | null;
  worstMaxCellId: string | null;
  latestMinCellVoltageV: number | null;
  latestMaxCellVoltageV: number | null;
  latestSpreadMv: number | null;
  latestTimestamp: number | null;
  latestBatteryVoltageV: number | null;
  worstBatteryVoltageV: number | null;
  soc: number | null;
  socFormatted: string | null;
  socCode: string | null;
  socInstance: number | null;
  graphError?: string;
}

function cellNote(cellId: string | null): string {
  return cellId ? ` cell ${cellId}` : '';
}

export function formatBatterySpreadText(summary: {
  idSite: number;
  hours: number;
  batteries: BatterySpreadRow[];
  diagnosticsRecords: number;
  truncated: boolean;
  timeZone?: string | null;
}): string {
  const lines = [
    `# Battery cell spread — site ${summary.idSite} — last ${summary.hours} h`,
    '',
    `Diagnostics rows scanned: ${summary.diagnosticsRecords}${summary.truncated ? ' (truncated)' : ''}`,
    `Batteries with cell-voltage attributes: ${summary.batteries.length}`,
  ];
  if (summary.timeZone) {
    lines.push(`Timezone: ${summary.timeZone}`);
  }
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
    const zone = summary.timeZone;
    const bucket =
      battery.bucketSeconds === null ? 'n/a' : `${battery.bucketSeconds} s`;
    const upper = battery.simultaneousSpreadUpperBound
      ? `; upper bound — buckets are ${battery.bucketSeconds} s, so the min and max in a bucket may not be the same instant`
      : '';
    const worstCells =
      battery.worstMinCellId || battery.worstMaxCellId
        ? ` cells ${battery.worstMinCellId ?? '?'}/${battery.worstMaxCellId ?? '?'}`
        : '';
    lines.push('', `## instance ${battery.instance}${name}`);
    lines.push(`- bucket resolution: ${bucket}`);
    lines.push(
      `- max cell voltage: ${fmtVolts(battery.maxCellVoltageV)}${fmtAt(battery.maxCellVoltageAt, zone)}${cellNote(battery.maxCellId)}`,
    );
    lines.push(
      `- min cell voltage: ${fmtVolts(battery.minCellVoltageV)}${fmtAt(battery.minCellVoltageAt, zone)}${cellNote(battery.minCellId)}`,
    );
    lines.push(`- spread: ${fmtMv(battery.spreadMv)} (envelope over the window, bucket min of mcV and bucket max of McV)`);
    lines.push(
      `- largest simultaneous spread: ${fmtMv(battery.largestSimultaneousSpreadMv)}${fmtAt(battery.largestSimultaneousSpreadAt, zone)}${worstCells} (${battery.alignedSamples} aligned sample(s)${upper})`,
    );
    lines.push(
      `- battery voltage at worst spread: ${fmtVolts(battery.worstBatteryVoltageV)}${fmtAt(battery.largestSimultaneousSpreadAt, zone)}`,
    );
    lines.push(`- latest battery voltage: ${fmtVolts(battery.latestBatteryVoltageV)}`);
    const socText =
      battery.soc === null
        ? 'n/a'
        : `${battery.socFormatted ?? `${formatNumber(battery.soc)} %`} (code ${battery.socCode ?? '?'}, instance ${battery.socInstance ?? '?'})`;
    lines.push(`- latest SOC: ${socText}`);
    lines.push(
      `- latest snapshot: min ${fmtVolts(battery.latestMinCellVoltageV)}, max ${fmtVolts(battery.latestMaxCellVoltageV)}, spread ${fmtMv(battery.latestSpreadMv)}${fmtAt(battery.latestTimestamp, zone)}`,
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
    useMinMax: 1,
    'attributeCodes[]': ['mcV', 'McV', 'V', 'bv'],
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
        'then reads those attributes from GET /installations/{idSite}/widgets/Graph with useMinMax=1, using each bucket\'s minimum mcV and maximum McV. ' +
        'When buckets are longer than one minute, the same-time spread is an upper bound. ' +
        'Returns max cell voltage, min cell voltage, envelope spread in mV, the worst same-time spread, bucket resolution, battery voltage, and the latest state of charge. GET only.',
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
          let worstBatteryVoltageV: number | null = null;
          try {
            const graph = await loadGraph(auth.client, idSite, group.instance, start, end);
            const minSeries = seriesForCode(graph, 'mcV');
            const maxSeries = seriesForCode(graph, 'McV');
            spread = computeSpread(minSeries, maxSeries, latestMin, latestMax);
            const voltageSeries = seriesForCode(graph, 'V');
            const altVoltage = seriesForCode(graph, 'bv');
            const volts = voltageSeries.length > 0 ? voltageSeries : altVoltage;
            if (spread.largestSimultaneousSpreadAt !== null) {
              const tolerance = Math.max(spread.bucketSeconds ?? 0, ALIGN_TOLERANCE_SEC);
              worstBatteryVoltageV = voltageAt(volts, spread.largestSimultaneousSpreadAt, tolerance);
            }
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
            latestBatteryVoltageV: group.voltage?.value ?? null,
            worstBatteryVoltageV,
            soc: group.soc?.value ?? null,
            socFormatted: group.soc?.formatted ?? null,
            socCode: group.soc?.code ?? null,
            socInstance: group.soc ? group.soc.instance : null,
            ...(graphError ? { graphError } : {}),
          });
        }
        const timeZone = await lookupSiteTimeZone(auth.client, idSite);
        const summary = {
          success: true as const,
          idSite,
          timeZone,
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
