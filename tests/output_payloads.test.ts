import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import Ajv from 'ajv';
import { outputSchemas } from '../src/tools/output_schemas.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => JSON.parse(readFileSync(resolve(dir, `${name}.json`), 'utf8')) as unknown;

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'output', target: 'draft-7' }) as Record<string, unknown>;
  delete out['$schema'];
  return out;
}

function accepts(schema: z.ZodType, payload: unknown): void {
  const parsed = schema.safeParse(payload);
  expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  const validate = ajv.compile(jsonSchema(schema));
  const ok = validate(payload);
  expect(ok, JSON.stringify(validate.errors)).toBe(true);
  expect(jsonSchema(schema)['additionalProperties']).not.toBe(false);
}

describe('output schemas accept observed VRM payloads', () => {
  it('stats — series map mixes point arrays and false', () => {
    accepts(outputSchemas.stats, fixture('stats_live'));
  });

  it('system overview — devices include instances above 255 and a gateway with no instance', () => {
    accepts(outputSchemas.systemOverview, fixture('system_overview'));
  });

  it('diagnostics — array of rows, and the single-object shape from the OpenAPI document', () => {
    accepts(outputSchemas.diagnostics, fixture('diagnostics_cells'));
    accepts(outputSchemas.diagnostics, {
      success: true,
      records: (fixture('diagnostics_cells') as { records: unknown[] }).records[0],
      num_records: 1,
    });
  });

  it('installation-data-attributes — records carry value_<code> keys', () => {
    accepts(outputSchemas.dataAttributeSearch, fixture('installation_data_attributes'));
  });

  it('data-attributes catalog — map keyed by id, with no success wrapper', () => {
    accepts(outputSchemas.dataAttributeCatalog, fixture('data_attributes_map'));
    accepts(outputSchemas.dataAttributeCatalog, { success: true, records: [{ code: 'bs' }] });
  });

  it('graph — useMinMax points may end in null or a string cell id', () => {
    accepts(outputSchemas.widgetGraph, fixture('widget_graph_cells'));
    accepts(outputSchemas.widgetGraph, fixture('widget_graph_bs_bv'));
    accepts(outputSchemas.widgetGraph, fixture('widget_graph_cell_id'));
  });

  it('widget and a minimal success envelope still validate', () => {
    accepts(outputSchemas.widget, fixture('widget_battery_summary'));
    accepts(outputSchemas.success, { success: true, records: { anything: 1 } });
  });
});
