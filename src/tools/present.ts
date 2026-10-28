/**
 * Text renderers for VRM payloads. Many MCP clients only show `content`
 * text and drop `structuredContent`, so the numbers have to live here.
 */

export interface SeriesSample {
  /** Unix timestamp, seconds or milliseconds as returned by VRM. */
  ts: number;
  /** Primary value (index 1): the sample, or the bucket mean when min/max are present. */
  value: number;
  /** Bucket minimum when useMinMax sent one; otherwise the primary value. */
  low: number;
  /** Bucket maximum when useMinMax sent one; otherwise the primary value. */
  high: number;
  /** Cell id VRM appends with useMinMax, e.g. "0103". */
  cellId: string | null;
}

const COMPACT_SAMPLES = 12;
const DEFAULT_POINT_CAP = 2_000;

export function formatTimestamp(ts: number, timeZone?: string | null): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return String(ts);
  }
  const utc = date.toISOString();
  if (!timeZone) {
    return utc;
  }
  try {
    const local = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(date);
    return `${utc} (${local} ${timeZone})`;
  } catch {
    return utc;
  }
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

/** Pull a unit out of a VRM printf format such as `%.2F V` or `%.1F %%`. */
export function unitFromFormat(formatWithUnit: string | null | undefined): string | null {
  if (!formatWithUnit) {
    return null;
  }
  if (formatWithUnit.includes('%%')) {
    return '%';
  }
  const stripped = formatWithUnit.replace(/%[-+0-9.]*[a-zA-Z]/g, '').trim();
  return stripped.length > 0 ? stripped : null;
}

function numericAt(point: unknown[], index: number): number | null {
  const n = point[index];
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function parseSeriesPoint(point: unknown): SeriesSample | null {
  if (!Array.isArray(point) || point.length < 2) {
    return null;
  }
  const ts = point[0];
  if (typeof ts !== 'number' || !Number.isFinite(ts)) {
    return null;
  }
  const value = numericAt(point, 1);
  if (value === null) {
    return null;
  }
  // useMinMax points are [ts, mean, bucketMin, bucketMax, cellId?].
  // A string such as "0103" is a cell id, not a voltage.
  const bucketMin = numericAt(point, 2);
  const bucketMax = numericAt(point, 3);
  let cellId: string | null = null;
  for (let i = 1; i < point.length; i++) {
    const item = point[i];
    if (typeof item === 'string' && item.trim() !== '') {
      cellId = item;
      break;
    }
  }
  return {
    ts,
    value,
    low: bucketMin ?? value,
    high: bucketMax ?? value,
    cellId,
  };
}

export function parseSeries(points: unknown): SeriesSample[] {
  if (!Array.isArray(points)) {
    return [];
  }
  const out: SeriesSample[] = [];
  for (const point of points) {
    const parsed = parseSeriesPoint(point);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

export function pickSamples<T>(items: T[], count: number): T[] {
  if (items.length <= count) {
    return items;
  }
  if (count <= 1) {
    return [items[0]!];
  }
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (items.length - 1)) / (count - 1));
    out.push(items[idx]!);
  }
  return out;
}

interface AttributeMeta {
  code?: string;
  description?: string;
  formatWithUnit?: string | null;
}

function asMeta(value: unknown): AttributeMeta | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const m = value as Record<string, unknown>;
  return {
    code: typeof m['code'] === 'string' ? m['code'] : undefined,
    description: typeof m['description'] === 'string' ? m['description'] : undefined,
    formatWithUnit: typeof m['formatWithUnit'] === 'string' ? m['formatWithUnit'] : null,
  };
}

function seriesLabel(key: string, meta: AttributeMeta | undefined): string {
  const code = meta?.code;
  const description = meta?.description;
  if (description && code) {
    return `${description} (\`${code}\`, id ${key})`;
  }
  if (code) {
    return `\`${code}\` (id ${key})`;
  }
  if (description) {
    return `${description} (id ${key})`;
  }
  return `id ${key}`;
}

function withUnit(value: number, unit: string | null): string {
  return unit ? `${formatNumber(value)} ${unit}` : formatNumber(value);
}

function cellSuffix(cellId: string | null | undefined): string {
  return cellId ? ` cell ${cellId}` : '';
}

export function formatSeriesBlock(
  label: string,
  rawPoints: unknown,
  formatWithUnit: string | null | undefined,
  opts?: { includePoints?: boolean; pointCap?: number; timeZone?: string | null },
): string[] {
  const rawCount = Array.isArray(rawPoints) ? rawPoints.length : 0;
  const samples = parseSeries(rawPoints);
  const unit = unitFromFormat(formatWithUnit);
  const lines = [`## ${label}`, `- ${rawCount} point(s)`];
  if (samples.length === 0) {
    lines.push('- no numeric samples');
    return lines;
  }

  let min = samples[0]!;
  let max = samples[0]!;
  for (const sample of samples) {
    if (sample.low < min.low) {
      min = sample;
    }
    if (sample.high > max.high) {
      max = sample;
    }
  }
  const last = samples[samples.length - 1]!;
  const zone = opts?.timeZone;
  lines.push(`- min: ${withUnit(min.low, unit)} at ${formatTimestamp(min.ts, zone)}${cellSuffix(min.cellId)}`);
  lines.push(`- max: ${withUnit(max.high, unit)} at ${formatTimestamp(max.ts, zone)}${cellSuffix(max.cellId)}`);
  lines.push(`- last: ${withUnit(last.value, unit)} at ${formatTimestamp(last.ts, zone)}${cellSuffix(last.cellId)}`);

  const includePoints = opts?.includePoints === true;
  const cap = opts?.pointCap ?? DEFAULT_POINT_CAP;
  if (includePoints) {
    const shown = samples.slice(0, cap);
    lines.push(`- points (${shown.length}${shown.length < samples.length ? ` of ${samples.length}` : ''}):`);
    for (const sample of shown) {
      lines.push(`  ${formatTimestamp(sample.ts, opts?.timeZone)} ${withUnit(sample.value, unit)}${cellSuffix(sample.cellId)}`);
    }
    if (shown.length < samples.length) {
      lines.push(`  … ${samples.length - shown.length} more not shown`);
    }
  } else {
    const compact = pickSamples(samples, COMPACT_SAMPLES);
    const rendered = compact.map(
      (sample) => `${formatNumber(sample.value)}@${formatTimestamp(sample.ts, opts?.timeZone)}${sample.cellId ? `#${sample.cellId}` : ''}`,
    );
    lines.push(`- compact (${compact.length} of ${samples.length}): ${rendered.join(', ')}`);
  }
  return lines;
}

export function formatGraphText(
  idSite: number,
  payload: unknown,
  opts?: { includePoints?: boolean; timeZone?: string | null },
): string {
  const root = (payload ?? {}) as {
    records?: { data?: Record<string, unknown>; meta?: Record<string, unknown>; instance?: unknown };
  };
  const data = root.records?.data ?? {};
  const meta = root.records?.meta ?? {};
  const keys = Object.keys(data);
  const lines = [`# Graph data — site ${idSite}`, '', `Series fetched: ${keys.length}`];
  if (typeof root.records?.instance === 'number') {
    lines.push(`Instance: ${root.records.instance}`);
  }
  if (opts?.timeZone) {
    lines.push(`Timezone: ${opts.timeZone}`);
  }
  lines.push('');
  if (keys.length === 0) {
    lines.push('No series in records.data.');
    return lines.join('\n');
  }
  for (const key of keys) {
    const m = asMeta(meta[key]);
    lines.push(...formatSeriesBlock(seriesLabel(key, m), data[key], m?.formatWithUnit, opts));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

interface Reading {
  code?: string;
  description?: string;
  valueText: string;
  unit: string | null;
  formatted: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readingFrom(value: Record<string, unknown>, meta: AttributeMeta | undefined): Reading | null {
  const hasValue =
    'value' in value ||
    'valueFloat' in value ||
    'formattedValue' in value ||
    'valueFormattedWithUnit' in value ||
    'rawValue' in value;
  if (!hasValue) {
    return null;
  }
  const code = typeof value['code'] === 'string' ? value['code'] : meta?.code;
  const description =
    typeof value['dataAttributeName'] === 'string'
      ? value['dataAttributeName']
      : typeof value['description'] === 'string'
        ? value['description']
        : meta?.description;
  const format =
    typeof value['formatWithUnit'] === 'string' ? value['formatWithUnit'] : meta?.formatWithUnit;
  const formattedRaw =
    value['valueFormattedWithUnit'] ?? value['formattedValue'] ?? value['valueFormattedValueOnly'];
  const formatted =
    typeof formattedRaw === 'string'
      ? formattedRaw
      : formattedRaw === null || formattedRaw === undefined
        ? ''
        : String(formattedRaw);
  const primary = value['valueFloat'] ?? value['value'] ?? value['rawValue'];
  const valueText =
    typeof primary === 'number'
      ? formatNumber(primary)
      : typeof primary === 'string'
        ? primary
        : formatted || '(none)';
  return {
    code,
    description,
    valueText,
    unit: unitFromFormat(format),
    formatted: formatted || valueText,
  };
}

function formatReadingLine(id: string, reading: Reading): string {
  const name = reading.description ?? reading.code ?? `id ${id}`;
  const code = reading.code ? ` (\`${reading.code}\`, id ${id})` : ` (id ${id})`;
  const unit = reading.unit ?? '(none)';
  return `- ${name}${code}: value=${reading.valueText} unit=${unit} formatted=${reading.formatted}`;
}

export function formatWidgetText(
  idSite: number,
  widget: string,
  payload: unknown,
  opts?: { timeZone?: string | null },
): string {
  const root = (payload ?? {}) as {
    success?: unknown;
    records?: unknown;
  };
  const lines = [`# Widget ${widget} — site ${idSite}`, '', `success: ${String(root.success)}`];
  const records = isObject(root.records) ? root.records : undefined;
  const data = records && isObject(records['data']) ? records['data'] : undefined;
  const meta = records && isObject(records['meta']) ? records['meta'] : undefined;

  if (data && 'hasOldData' in data) {
    lines.push(`- hasOldData: ${String(data['hasOldData'])}`);
  }
  if (data && isObject(data['secondsAgo'])) {
    const ago = data['secondsAgo'];
    const formatted = ago['valueFormattedWithUnit'];
    const value = ago['value'];
    lines.push(`- freshness: ${typeof formatted === 'string' ? formatted : String(value ?? '')}`);
  } else if (data && (typeof data['secondsAgo'] === 'number' || typeof data['secondsAgo'] === 'string')) {
    lines.push(`- freshness: ${String(data['secondsAgo'])}`);
  }

  if (!data) {
    lines.push('', 'No records.data in this widget payload.');
    return lines.join('\n');
  }

  const order = Array.isArray(records?.['attributeOrder'])
    ? (records['attributeOrder'] as unknown[]).map((id) => String(id))
    : [];
  const keys = [...order.filter((id) => id in data), ...Object.keys(data).filter((id) => !order.includes(id))];
  const readings: string[] = [];
  const series: string[] = [];
  const rendered = new Set<string>();

  for (const key of keys) {
    if (key === 'hasOldData' || key === 'secondsAgo') {
      continue;
    }
    const value = data[key];
    const m = meta ? asMeta(meta[key]) : undefined;
    if (Array.isArray(value)) {
      series.push(...formatSeriesBlock(seriesLabel(key, m), value, m?.formatWithUnit, { timeZone: opts?.timeZone }));
      rendered.add(key);
      continue;
    }
    if (isObject(value)) {
      const reading = readingFrom(value, m);
      if (reading) {
        readings.push(formatReadingLine(key, reading));
        rendered.add(key);
        continue;
      }
    }
  }

  const missing: string[] = [];
  if (meta) {
    for (const [key, value] of Object.entries(meta)) {
      if (rendered.has(key)) {
        continue;
      }
      const code = asMeta(value)?.code;
      if (code) {
        missing.push(code);
      }
    }
  }

  lines.push('');
  if (readings.length === 0 && series.length === 0) {
    lines.push('No attribute readings in records.data.');
  } else {
    if (readings.length > 0) {
      lines.push(...readings);
    }
    if (series.length > 0) {
      if (readings.length > 0) {
        lines.push('');
      }
      lines.push(...series);
    }
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 20);
    const extra = missing.length > shown.length ? ` (+${missing.length - shown.length} more)` : '';
    lines.push('', `Attributes with no reading: ${shown.join(', ')}${extra}`);
  }
  return lines.join('\n');
}

export function formatOverviewText(idSite: number, payload: unknown): string {
  const root = (payload ?? {}) as { success?: unknown; records?: { devices?: unknown } };
  const devices = Array.isArray(root.records?.devices) ? root.records.devices : [];
  const lines = [`# System overview — site ${idSite}`, '', `success: ${String(root.success)}`, `Devices: ${devices.length}`, ''];
  for (const device of devices) {
    if (!isObject(device)) {
      continue;
    }
    const name = typeof device['name'] === 'string' ? device['name'] : '(unnamed)';
    const product = typeof device['productName'] === 'string' ? device['productName'] : '';
    const instance = typeof device['instance'] === 'number' ? String(device['instance']) : '(none)';
    const productPart = product ? ` — ${product}` : '';
    lines.push(`- ${name}${productPart} — instance ${instance}`);
  }
  return lines.join('\n').trimEnd();
}

function diagnosticCode(record: Record<string, unknown>): string {
  return typeof record['code'] === 'string' ? record['code'] : '';
}

function diagnosticRank(record: Record<string, unknown>): number {
  const code = diagnosticCode(record);
  if (code === 'mcV' || code === 'McV') {
    return 0;
  }
  if (code === 'SOC' || code === 'bs') {
    return 1;
  }
  return 2;
}

export function formatDiagnosticsText(idSite: number, payload: unknown, opts?: { timeZone?: string | null }): string {
  const root = (payload ?? {}) as { records?: unknown };
  const records = Array.isArray(root.records) ? root.records : root.records && isObject(root.records) ? [root.records] : [];
  const rows = records.filter(isObject);
  const lines = [
    `# Diagnostics — site ${idSite}`,
    '',
    `Diagnostic entries: ${Array.isArray(root.records) ? root.records.length : rows.length > 0 ? rows.length : 'n/a'}`,
  ];
  if (opts?.timeZone) {
    lines.push(`Timezone: ${opts.timeZone}`);
  }
  if (rows.length === 0) {
    return lines.join('\n');
  }
  const ranked = [...rows].sort((a, b) => diagnosticRank(a) - diagnosticRank(b));
  const shown = ranked.slice(0, 40);
  lines.push('');
  for (const row of shown) {
    const instance = typeof row['instance'] === 'number' ? String(row['instance']) : '?';
    const device = typeof row['Device'] === 'string' ? row['Device'] : '';
    const code = diagnosticCode(row) || '(no code)';
    const description = typeof row['description'] === 'string' ? row['description'] : '';
    const raw = row['rawValue'];
    const formatted = row['formattedValue'];
    const rawText = raw === undefined || raw === null ? '' : ` raw=${typeof raw === 'number' ? formatNumber(raw) : String(raw)}`;
    const formattedText =
      formatted === undefined || formatted === null ? '' : ` formatted=${typeof formatted === 'string' ? formatted : String(formatted)}`;
    const when = typeof row['timestamp'] === 'number' ? ` at ${formatTimestamp(row['timestamp'], opts?.timeZone)}` : '';
    const deviceText = device ? ` ${device}` : '';
    const descText = description ? ` ${description}` : '';
    lines.push(`- instance ${instance}${deviceText} \`${code}\`${descText}:${rawText}${formattedText}${when}`);
  }
  if (ranked.length > shown.length) {
    lines.push(`- … and ${ranked.length - shown.length} more`);
  }
  return lines.join('\n');
}

function isStatsSeriesMap(records: unknown): records is Record<string, unknown> {
  if (!isObject(records)) {
    return false;
  }
  return Object.values(records).every((value) => Array.isArray(value) || typeof value === 'boolean' || value === null);
}

export function formatStatsText(idSite: number, payload: unknown, opts?: { timeZone?: string | null }): string {
  const root = (payload ?? {}) as { success?: unknown; records?: unknown };
  const lines = [`# Stats — site ${idSite}`, '', `success: ${String(root.success)}`];
  if (opts?.timeZone) {
    lines.push(`Timezone: ${opts.timeZone}`);
  }
  if (!isStatsSeriesMap(root.records)) {
    return lines.join('\n');
  }
  const keys = Object.keys(root.records);
  lines.push('', `Series: ${keys.length}`, '');
  for (const key of keys) {
    const value = root.records[key];
    if (!Array.isArray(value)) {
      lines.push(`- \`${key}\`: no data`);
      continue;
    }
    const block = formatSeriesBlock(`\`${key}\``, value, null, { timeZone: opts?.timeZone });
    lines.push(...block);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

interface CatalogAttr {
  key: string;
  code?: string;
  description?: string;
  formatWithUnit?: string;
  dataType?: string;
}

function catalogAttr(key: string, value: Record<string, unknown>): CatalogAttr | null {
  if (typeof value['code'] !== 'string') {
    return null;
  }
  return {
    key,
    code: value['code'],
    description: typeof value['description'] === 'string' ? value['description'] : undefined,
    formatWithUnit: typeof value['formatWithUnit'] === 'string' ? value['formatWithUnit'] : undefined,
    dataType: typeof value['dataType'] === 'string' ? value['dataType'] : undefined,
  };
}

export function formatDataAttributeCatalog(payload: unknown, page?: number): string {
  const lines = ['# Data attributes', ''];
  if (!isObject(payload)) {
    lines.push('0 attribute(s).');
    return lines.join('\n');
  }
  const attrs: CatalogAttr[] = [];
  if (Array.isArray(payload['records'])) {
    payload['records'].forEach((row, index) => {
      if (!isObject(row)) {
        return;
      }
      const key = row['idDataAttribute'] === undefined ? String(index) : String(row['idDataAttribute']);
      const attr = catalogAttr(key, row);
      if (attr) {
        attrs.push(attr);
      }
    });
  } else {
    for (const [key, value] of Object.entries(payload)) {
      if (!isObject(value)) {
        continue;
      }
      const attr = catalogAttr(key, value);
      if (attr) {
        attrs.push(attr);
      }
    }
  }
  const pageNote = page !== undefined ? ` on page ${page}` : '';
  lines.push(`${attrs.length} attribute(s)${pageNote}.`);
  const shown = attrs.slice(0, 40);
  if (shown.length > 0) {
    lines.push('');
  }
  for (const attr of shown) {
    const desc = attr.description ? ` ${attr.description}` : '';
    const unit = attr.formatWithUnit ? ` — ${attr.formatWithUnit}` : '';
    const type = attr.dataType ? ` (${attr.dataType})` : '';
    lines.push(`- \`${attr.code}\`${type}${desc}${unit}`);
  }
  if (attrs.length > shown.length) {
    lines.push(`- … and ${attrs.length - shown.length} more`);
  }
  return lines.join('\n');
}
