import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatDataAttributeCatalog,
  formatDiagnosticsText,
  formatGraphText,
  formatNumber,
  formatSeriesBlock,
  formatOverviewText,
  formatStatsText,
  formatTimestamp,
  formatWidgetText,
  parseSeriesPoint,
  unitFromFormat,
} from '../src/tools/present.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', `${name}.json`), 'utf8'));

describe('unit and timestamp formatting', () => {
  it('reads units from VRM printf formats', () => {
    expect(unitFromFormat('%.2F V')).toBe('V');
    expect(unitFromFormat('%.2FV')).toBe('V');
    expect(unitFromFormat('%.1F %%')).toBe('%');
    expect(unitFromFormat('%s')).toBeNull();
    expect(unitFromFormat(null)).toBeNull();
  });

  it('formats unix seconds and milliseconds as ISO', () => {
    expect(formatTimestamp(1793188867)).toBe(new Date(1793188867 * 1000).toISOString());
    expect(formatTimestamp(1793105669000)).toBe(new Date(1793105669000).toISOString());
    const local = formatTimestamp(1793188867, 'Europe/Prague');
    expect(local.startsWith(new Date(1793188867 * 1000).toISOString())).toBe(true);
    expect(local).toMatch(/Europe\/Prague/);
    expect(formatTimestamp(1793188867, 'Not/AZone')).toBe(new Date(1793188867 * 1000).toISOString());
  });

  it('trims noisy floats', () => {
    expect(formatNumber(3.3)).toBe('3.3');
    expect(formatNumber(13.632)).toBe('13.632');
  });
});

describe('graph text', () => {
  it('keeps the primary value and the bucket extremes when a point ends in null', () => {
    const parsed = parseSeriesPoint([1793188867, 3.32, 3.1, 3.4, null]);
    expect(parsed).toEqual({ ts: 1793188867, value: 3.32, low: 3.1, high: 3.4, cellId: null });
    expect(parseSeriesPoint([1])).toBeNull();
    expect(parseSeriesPoint([1, null, null])).toBeNull();
  });

  it('lists min, max, last, and a compact series for each attribute', () => {
    const text = formatGraphText(151755, fixture('widget_graph_cells'));
    expect(text).toMatch(/Series fetched: 2/);
    expect(text).toMatch(/Instance: 1/);
    expect(text).toMatch(/Minimum cell voltage \(`mcV`, id 173\)/);
    expect(text).toMatch(/2 point\(s\)/);
    expect(text).toMatch(/min: 3\.3 V at /);
    expect(text).toMatch(/max: 3\.32 V at /);
    expect(text).toMatch(/last: 3\.3 V at /);
    expect(text).toMatch(/Maximum cell voltage \(`McV`, id 174\)/);
    expect(text).toMatch(/max: 3\.35 V at /);
    expect(text).toMatch(/compact \(2 of 2\)/);
    expect(text).not.toMatch(/structured payload/);
  });

  it('keeps a string cell id on useMinMax points and shows it next to the extreme', () => {
    const parsed = parseSeriesPoint([1793188867, 3.0, 2.78, 3.1, '0103']);
    expect(parsed?.cellId).toBe('0103');
    expect(parsed?.low).toBe(2.78);
    expect(parsed?.high).toBe(3.1);
    expect(parsed?.value).toBe(3);
    const text = formatGraphText(216772, fixture('widget_graph_cell_id'), { timeZone: 'Europe/Prague' });
    expect(text).toMatch(/Timezone: Europe\/Prague/);
    expect(text).toMatch(/min: 2\.78 V at .+Europe\/Prague\) cell 0103/);
    expect(text).toMatch(/max: 3\.56 V at .+cell 0201/);
    expect(text).toContain('#0103');
  });

  it('lists every sample when includePoints is set, and caps the dump', () => {
    const payload = {
      success: true,
      records: {
        data: { '1': [[10, 1], [20, 2], [30, 3], [40, 4]] },
        meta: { '1': { code: 'bv', description: 'Voltage', formatWithUnit: '%.2F V' } },
      },
    };
    const full = formatGraphText(1, payload, { includePoints: true });
    expect(full).toMatch(/points \(4\):/);
    expect(full).toMatch(/1 V/);
    expect(full).toMatch(/4 V/);
    expect(full).not.toMatch(/compact/);

    const capped = formatSeriesBlock('Voltage', payload.records.data['1'], '%.2F V', { includePoints: true, pointCap: 2 });
    expect(capped.join('\n')).toMatch(/points \(2 of 4\)/);
    expect(capped.join('\n')).toMatch(/2 more not shown/);
  });

  it('says when a series has no numeric samples', () => {
    const text = formatGraphText(1, { success: true, records: { data: { x: [] }, meta: {} } });
    expect(text).toMatch(/0 point\(s\)/);
    expect(text).toMatch(/no numeric samples/);
  });
});

describe('widget text', () => {
  it('prints value, unit, and formatted value for each reading', () => {
    const text = formatWidgetText(151755, 'LithiumBMS', {
      success: true,
      records: {
        data: {
          hasOldData: false,
          secondsAgo: { value: 9, valueFormattedWithUnit: '9s' },
          '173': {
            code: 'mcV',
            dataAttributeName: 'Minimum cell voltage',
            valueFloat: 3.3,
            value: '3.3',
            formatWithUnit: '%.2F V',
            valueFormattedWithUnit: '3.30 V',
          },
          '165': {
            code: 'liS',
            dataAttributeName: 'State',
            value: 'Running',
            formatWithUnit: '%s',
            valueFormattedWithUnit: 'Running',
          },
        },
        meta: {
          '174': { code: 'McV', description: 'Maximum cell voltage', formatWithUnit: '%.2F V' },
        },
        attributeOrder: [173, 165],
      },
    });
    expect(text).toMatch(/# Widget LithiumBMS — site 151755/);
    expect(text).toMatch(/freshness: 9s/);
    expect(text).toMatch(/Minimum cell voltage \(`mcV`, id 173\): value=3\.3 unit=V formatted=3\.30 V/);
    expect(text).toMatch(/State \(`liS`, id 165\): value=Running unit=\(none\) formatted=Running/);
    expect(text).toMatch(/Attributes with no reading: McV/);
  });

  it('summarizes series stored inside a widget and notes an empty payload', () => {
    const series = formatWidgetText(1, 'HistoricData', {
      success: true,
      records: { data: { '47': [[100, 48.5], [160, 49.1]] }, meta: { '47': { code: 'V', description: 'Voltage', formatWithUnit: '%.2F V' } } },
    });
    expect(series).toMatch(/min: 48\.5 V/);
    expect(series).toMatch(/max: 49\.1 V/);

    const empty = formatWidgetText(1, 'BatterySummary', { success: true, records: { data: { hasOldData: false } } });
    expect(empty).toMatch(/No attribute readings/);
    expect(formatWidgetText(1, 'GPS', { success: false })).toMatch(/No records\.data/);
  });
});

describe('overview, diagnostics, stats, and attribute catalog text', () => {
  it('lists devices with their instances', () => {
    const text = formatOverviewText(151734, fixture('system_overview'));
    expect(text).toMatch(/System overview — site 151734/);
    expect(text).toMatch(/Battery Monitor — SmartShunt 500A — instance 288/);
    expect(text).toMatch(/instance 257/);
    expect(text).toMatch(/instance \(none\)/);
  });

  it('puts cell-voltage rows ahead of the rest and keeps the entry count', () => {
    const payload = {
      success: true,
      records: [
        { code: 'V', instance: 0, description: 'Voltage', rawValue: 50, formattedValue: '50 V', Device: 'Shunt' },
        { code: 'mcV', instance: 512, description: 'Minimum cell voltage', rawValue: '3.20', formattedValue: '3.20 V', Device: 'Pylontech battery', timestamp: 1793190000 },
      ],
    };
    const text = formatDiagnosticsText(219742, payload);
    expect(text).toMatch(/Diagnostic entries: 2/);
    const mc = text.indexOf('`mcV`');
    const voltage = text.indexOf('`V`');
    expect(mc).toBeGreaterThan(-1);
    expect(mc).toBeLessThan(voltage);
    expect(text).toMatch(/instance 512 Pylontech battery `mcV`/);
    expect(text).toMatch(/raw=3\.2/);
    expect(text).toMatch(/at 2026-/);
    const zoned = formatDiagnosticsText(219742, payload, { timeZone: 'Europe/Prague' });
    expect(zoned).toMatch(/Timezone: Europe\/Prague/);
    expect(zoned).toMatch(/Europe\/Prague/);
    expect(formatDiagnosticsText(1, { records: { code: 'SOC', instance: 1, rawValue: 80 } })).toMatch(/Diagnostic entries: 1/);
  });

  it('summarizes stats series and marks boolean false as no data', () => {
    const text = formatStatsText(151734, fixture('stats_live'));
    expect(text).toMatch(/`bv`/);
    expect(text).toMatch(/min: 13\.38 at /);
    expect(text).toMatch(/max: 14\.25 at /);
    expect(text).toMatch(/`total_solar_yield`: no data/);
    expect(text).toMatch(/`iOI1`: no data/);
  });

  it('lists a bare attribute map and a records array', () => {
    const mapText = formatDataAttributeCatalog(fixture('data_attributes_map'));
    expect(mapText).toMatch(/2 attribute\(s\)/);
    expect(mapText).toMatch(/`mcV` \(float\) Minimum cell voltage — %\.2F V/);
    const arrayText = formatDataAttributeCatalog(
      { success: true, records: [{ idDataAttribute: 51, code: 'SOC', description: 'State of charge', dataType: 'float' }] },
      2,
    );
    expect(arrayText).toMatch(/1 attribute\(s\) on page 2/);
    expect(arrayText).toMatch(/`SOC`/);
    expect(formatDataAttributeCatalog(null)).toMatch(/0 attribute\(s\)/);
  });
});
