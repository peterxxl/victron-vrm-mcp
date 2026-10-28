import { describe, it, expect } from 'vitest';
import {
  coerceDiagnosticRecords,
  collectDiagnostics,
  computeSpread,
  formatBatterySpreadText,
  groupCellBatteries,
  largestSimultaneousSpread,
  numericValue,
  seriesForCode,
  spreadMillivolts,
  voltageAt,
  type DiagnosticRecord,
} from '../src/tools/battery.js';
import { parseSeries } from '../src/tools/present.js';

const cells: DiagnosticRecord[] = [
  {
    id: 1,
    code: 'mcV',
    instance: 512,
    Device: 'Pylontech battery',
    description: 'Minimum cell voltage',
    dbusPath: '/System/MinCellVoltage',
    rawValue: '3.20',
    formattedValue: '3.20 V',
    timestamp: 1000,
  },
  {
    id: 2,
    code: 'McV',
    instance: 512,
    Device: 'Pylontech battery',
    description: 'Maximum cell voltage',
    dbusPath: '/System/MaxCellVoltage',
    rawValue: 3.35,
    formattedValue: '3.35 V',
    timestamp: 1000,
  },
  {
    id: 3,
    code: 'SOC',
    instance: 512,
    dbusPath: '/Soc',
    rawValue: 59,
    formattedValue: '59.0 %',
    timestamp: 1000,
  },
  {
    id: 4,
    code: 'liH1',
    instance: 512,
    description: 'History; Min cell-voltage',
    dbusPath: '/History/MinimumCellVoltage',
    rawValue: 2.5,
    timestamp: 900,
  },
  {
    id: 5,
    instance: 1,
    description: 'Minimum cell voltage',
    dbusPath: '/Dc/0/MinCellVoltage',
    rawValue: 3.11,
    timestamp: 500,
    Device: 'Lynx',
  },
];

describe('diagnostic discovery', () => {
  it('parses numeric strings that include a unit', () => {
    expect(numericValue('3.30 V')).toBe(3.3);
    expect(numericValue(3.3)).toBe(3.3);
    expect(numericValue('nope')).toBeNull();
    expect(numericValue(null)).toBeNull();
  });

  it('accepts an array of rows or the single-object OpenAPI shape', () => {
    expect(coerceDiagnosticRecords(cells)).toHaveLength(5);
    expect(coerceDiagnosticRecords({ code: 'mcV', instance: 1, rawValue: 3 })).toHaveLength(1);
    expect(coerceDiagnosticRecords({ devices: [] })).toEqual([]);
    expect(coerceDiagnosticRecords(null)).toEqual([]);
  });

  it('pages until num_records is covered and stops on a repeated page', async () => {
    const pages = [
      { records: [cells[0], cells[1]], num_records: 3 },
      { records: [cells[2]], num_records: '3' },
    ];
    const collected = await collectDiagnostics(async (page) => pages[page - 1] ?? { records: [] }, { pageSize: 2, maxPages: 5 });
    expect(collected.records.map((r) => r.code)).toEqual(['mcV', 'McV', 'SOC']);
    expect(collected.truncated).toBe(false);
    expect(collected.reportedTotal).toBe(3);

    const repeated = await collectDiagnostics(
      async () => ({ records: [cells[0]], num_records: 5 }),
      { pageSize: 1, maxPages: 4 },
    );
    expect(repeated.records).toHaveLength(1);
    expect(repeated.truncated).toBe(true);
  });

  it('groups mcV/McV by instance, ignores history, and prefers same-instance SOC', () => {
    const groups = groupCellBatteries(cells);
    expect(groups.map((g) => g.instance)).toEqual([1, 512]);
    const pylon = groups[1]!;
    expect(pylon.device).toBe('Pylontech battery');
    expect(pylon.min?.value).toBe(3.2);
    expect(pylon.max?.value).toBe(3.35);
    expect(pylon.soc?.value).toBe(59);
    expect(pylon.soc?.code).toBe('SOC');
    const lynx = groups[0]!;
    expect(lynx.min?.value).toBe(3.11);
    expect(lynx.max).toBeNull();
    expect(lynx.soc).toBeNull();
    expect(groupCellBatteries(cells, 512)).toHaveLength(1);
    expect(groupCellBatteries(cells, 7)).toEqual([]);
  });
});

describe('spread math', () => {
  it('reports the envelope and the largest simultaneous gap separately', () => {
    const min = parseSeries([[100, 3.2], [200, 3.1], [300, 3.3]]);
    const max = parseSeries([[100, 3.3], [200, 3.4], [300, 3.35]]);
    const spread = computeSpread(min, max, 3.2, 3.35);
    expect(spread.source).toBe('graph');
    expect(spread.minCellVoltageV).toBe(3.1);
    expect(spread.maxCellVoltageV).toBe(3.4);
    expect(spread.spreadMv).toBe(300);
    expect(spread.largestSimultaneousSpreadMv).toBe(300);
    expect(spread.largestSimultaneousSpreadAt).toBe(200);
    expect(spread.alignedSamples).toBe(3);
    expect(spread.bucketSeconds).toBe(100);
    expect(spread.simultaneousSpreadUpperBound).toBe(true);
    expect(spreadMillivolts(0.05)).toBe(50);
  });

  it('uses bucket min of mcV and bucket max of McV, and keeps the cell id string', () => {
    const min = parseSeries([
      [0, 3.0, 2.78, 3.1, '0103'],
      [900, 3.1, 2.93, 3.2, '0104'],
    ]);
    const max = parseSeries([
      [0, 3.4, 3.3, 3.56, '0201'],
      [900, 3.4, 3.34, 3.53, '0202'],
    ]);
    expect(min[0]?.cellId).toBe('0103');
    expect(min[0]?.low).toBe(2.78);
    expect(max[0]?.high).toBe(3.56);
    const spread = computeSpread(min, max, null, null);
    expect(spread.minCellVoltageV).toBe(2.78);
    expect(spread.maxCellVoltageV).toBe(3.56);
    expect(spread.spreadMv).toBe(780);
    expect(spread.minCellId).toBe('0103');
    expect(spread.maxCellId).toBe('0201');
    expect(spread.largestSimultaneousSpreadMv).toBe(780);
    expect(spread.worstMinCellId).toBe('0103');
    expect(spread.worstMaxCellId).toBe('0201');
    expect(spread.bucketSeconds).toBe(900);
    expect(spread.simultaneousSpreadUpperBound).toBe(true);
    const volts = parseSeries([[0, 52.4], [900, 51.1]]);
    expect(voltageAt(volts, 0)).toBe(52.4);
  });

  it('pairs the nearest sample within two minutes when timestamps differ', () => {
    const min = parseSeries([[1_000, 3]]);
    const max = parseSeries([[1_060, 3.2]]);
    const near = largestSimultaneousSpread(min, max);
    expect(near.aligned).toBe(1);
    expect(near.spreadMv).toBe(200);
    const far = largestSimultaneousSpread(min, parseSeries([[1_400, 3.2]]));
    expect(far.aligned).toBe(0);
    expect(far.spreadMv).toBeNull();
  });

  it('falls back to the diagnostics snapshot when the graph is empty', () => {
    const spread = computeSpread([], [], 3.3, 3.35);
    expect(spread.source).toBe('diagnostics');
    expect(spread.spreadMv).toBe(50);
    expect(spread.largestSimultaneousSpreadMv).toBe(50);
    expect(spread.minCellVoltageAt).toBeNull();
  });

  it('reads graph series by attribute code', () => {
    const samples = seriesForCode(
      {
        records: {
          data: { '173': [[10, 3.3]], '9': [[10, 1]] },
          meta: { '173': { code: 'mcV' }, '9': { code: 'bv' } },
        },
      },
      'mcV',
    );
    expect(samples).toHaveLength(1);
    expect(samples[0]!.value).toBe(3.3);
  });
});

describe('cell spread text', () => {
  it('includes the voltages, both spreads, and SOC', () => {
    const text = formatBatterySpreadText({
      idSite: 219742,
      hours: 24,
      diagnosticsRecords: 4,
      truncated: false,
      batteries: [
        {
          instance: 512,
          device: 'Pylontech battery',
          minCellVoltageV: 3.1,
          minCellVoltageAt: 200,
          maxCellVoltageV: 3.4,
          maxCellVoltageAt: 200,
          spreadMv: 300,
          largestSimultaneousSpreadMv: 300,
          largestSimultaneousSpreadAt: 200,
          alignedSamples: 3,
          seriesSamples: { min: 3, max: 3 },
          source: 'graph',
          bucketSeconds: 900,
          simultaneousSpreadUpperBound: true,
          minCellId: '0103',
          maxCellId: '0201',
          worstMinCellId: '0103',
          worstMaxCellId: '0201',
          latestMinCellVoltageV: 3.2,
          latestMaxCellVoltageV: 3.35,
          latestSpreadMv: 150,
          latestTimestamp: 1000,
          latestBatteryVoltageV: 49.12,
          worstBatteryVoltageV: 52.4,
          soc: 59,
          socFormatted: '59.0 %',
          socCode: 'SOC',
          socInstance: 512,
        },
      ],
    });
    expect(text).toMatch(/instance 512 — Pylontech battery/);
    expect(text).toMatch(/max cell voltage: 3\.4 V at /);
    expect(text).toMatch(/min cell voltage: 3\.1 V at /);
    expect(text).toMatch(/spread: 300 mV/);
    expect(text).toMatch(/largest simultaneous spread: 300 mV/);
    expect(text).toMatch(/upper bound/);
    expect(text).toMatch(/bucket resolution: 900 s/);
    expect(text).toMatch(/cell 0103/);
    expect(text).toMatch(/cell 0201/);
    expect(text).toMatch(/battery voltage at worst spread: 52\.4 V/);
    expect(text).toMatch(/latest battery voltage: 49\.12 V/);
    expect(text).toMatch(/latest SOC: 59\.0 % \(code SOC, instance 512\)/);
    const zoned = formatBatterySpreadText({
      idSite: 216772,
      hours: 168,
      diagnosticsRecords: 4,
      truncated: false,
      timeZone: 'Europe/Prague',
      batteries: [
        {
          instance: 512,
          device: 'Pylontech battery',
          minCellVoltageV: 2.78,
          minCellVoltageAt: 100,
          maxCellVoltageV: 3.56,
          maxCellVoltageAt: 100,
          spreadMv: 780,
          largestSimultaneousSpreadMv: 780,
          largestSimultaneousSpreadAt: 100,
          alignedSamples: 1,
          seriesSamples: { min: 2, max: 2 },
          source: 'graph',
          bucketSeconds: 900,
          simultaneousSpreadUpperBound: true,
          minCellId: '0103',
          maxCellId: '0201',
          worstMinCellId: '0103',
          worstMaxCellId: '0201',
          latestMinCellVoltageV: 3.2,
          latestMaxCellVoltageV: 3.35,
          latestSpreadMv: 150,
          latestTimestamp: 1000,
          latestBatteryVoltageV: 49.12,
          worstBatteryVoltageV: 52.4,
          soc: 59,
          socFormatted: '59.0 %',
          socCode: 'SOC',
          socInstance: 512,
        },
      ],
    });
    expect(zoned).toMatch(/Timezone: Europe\/Prague/);
    expect(zoned).toMatch(/Europe\/Prague/);
    expect(formatBatterySpreadText({ idSite: 1, hours: 24, diagnosticsRecords: 0, truncated: true, batteries: [] })).toMatch(
      /truncated/,
    );
  });
});
