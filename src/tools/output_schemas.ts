import { z } from 'zod';

/**
 * Shared output schemas. MCP clients (SDK ≥ 1.28) validate `structuredContent`
 * against the JSON Schema advertised by `tools/list`. Zod 4 emits
 * `additionalProperties: false` for a plain `z.object()`, while this server
 * forwards the raw VRM payload, so a closed object rejects every extra field
 * VRM actually sends ("Structured content does not match the tool's output
 * schema"). `z.looseObject` advertises an open object and still checks the
 * fields we name.
 *
 * Fields whose real shape is polymorphic (stats series maps that mix arrays
 * and `false`, diagnostics rows that are either an array or one object, the
 * data-attribute catalog that is a map keyed by id) are typed `unknown` so a
 * new VRM field cannot take the tool down. The descriptions record the shape
 * we observed against the public demo and the VRM OpenAPI document.
 */
function open<T extends z.ZodRawShape>(shape: T) {
  return z.looseObject(shape);
}

/**
 * A graph sample is `[timestamp, value, …]`. With useMinMax, VRM appends the
 * bucket min, bucket max, and sometimes a string cell id such as "0103"
 * (or null). Extra elements are string | number | null.
 */
const graphPoint = z.array(z.union([z.number(), z.string(), z.null()]));

const deviceSummary = z.looseObject({
  name: z.string().nullable().optional(),
  productName: z.string().nullable().optional(),
  instance: z.number().nullable().optional(),
  idDeviceType: z.number().nullable().optional(),
});

export const outputSchemas = {
  success: open({
    success: z.boolean(),
  }),

  successWithIdSite: open({
    success: z.boolean(),
    idSite: z.union([z.number(), z.string()]).optional(),
  }),

  successWithRecords: open({
    success: z.boolean(),
    records: z.unknown().optional(),
  }),

  installations: open({
    success: z.boolean(),
    records: z
      .array(
        z.object({
          idSite: z.number(),
          name: z.string(),
          identifier: z.string(),
          accessLevel: z.number(),
          owner: z.boolean(),
          is_admin: z.boolean(),
          idUser: z.number(),
          pvMax: z.number().optional(),
          timezone: z.string().optional(),
        }).passthrough(),
      )
      .optional(),
    user: z
      .object({
        id: z.number(),
        name: z.string().optional(),
        email: z.string().optional(),
        country: z.string().optional(),
        accessLevel: z.number().optional(),
      })
      .passthrough()
      .optional(),
  }),

  alarms: open({
    success: z.boolean(),
    rateLimited: z.boolean().optional(),
    alarms: z.array(z.unknown()).optional(),
    devices: z.array(z.unknown()).optional(),
    users: z.array(z.unknown()).optional(),
    attributes: z.array(z.unknown()).optional(),
  }),

  tags: open({
    success: z.boolean(),
    tags: z.record(z.string(), z.array(z.string())).optional(),
  }),

  siteUsers: open({
    success: z.boolean(),
    users: z.array(z.unknown()).optional(),
    invites: z.array(z.unknown()).optional(),
    pending: z.array(z.unknown()).optional(),
    userGroups: z.array(z.unknown()).optional(),
    siteGroups: z.array(z.unknown()).optional(),
  }),

  widget: open({
    success: z.boolean(),
    records: z.unknown().optional(),
  }),

  widgetGraph: open({
    success: z.boolean(),
    records: z
      .looseObject({
        data: z.record(z.string(), z.array(graphPoint)).optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
        instance: z.number().optional(),
      })
      .optional(),
  }),

  /**
   * GET /installations/{idSite}/system-overview — `{ success, records: { devices } }`.
   * Gateway rows omit `instance`. CAN-bus batteries use instances such as 512.
   */
  systemOverview: open({
    success: z.boolean(),
    records: z
      .looseObject({
        devices: z.array(deviceSummary).optional(),
      })
      .optional(),
  }),

  /**
   * GET /installations/{idSite}/diagnostics. Live callers (and the community
   * clients) receive `records` as an array plus `num_records`. The OpenAPI
   * document instead describes one record object. Both are accepted.
   */
  diagnostics: open({
    success: z.boolean(),
    records: z.unknown().optional().describe(
      'Diagnostic rows: an array of { code, instance, rawValue, formattedValue, dbusPath, ... }, or a single row object.',
    ),
    num_records: z.union([z.number(), z.string()]).optional(),
  }),

  /**
   * GET /installations/{idSite}/stats. `records` is a map of attribute code →
   * `[timestamp_ms, mean, min?, max?][]`, or `false` when that series is empty.
   * `totals` maps the same codes to a number or `false`. `show_instance` nests
   * those maps under instance ids.
   */
  stats: open({
    success: z.boolean(),
    records: z.unknown().optional(),
    totals: z.unknown().optional(),
  }),

  download: open({
    contentType: z.string(),
    bytes: z.number(),
    base64: z.string(),
  }),

  accessTokenCreate: open({
    success: z.boolean(),
    token: z.string().optional(),
    idAccessToken: z.number().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),

  accessTokenDelete: open({
    success: z.boolean(),
    data: z
      .object({
        removed: z.number().optional(),
      })
      .passthrough()
      .optional(),
  }),

  forecastsLastReset: open({
    success: z.boolean(),
    last_reset: z.number().optional(),
  }),

  /**
   * GET /installation-data-attributes. Records are installations; each may
   * carry extra `value_<code>` keys. Attribute metadata is a separate array.
   */
  dataAttributeSearch: open({
    success: z.boolean(),
    records: z
      .union([
        z.array(
          z.looseObject({
            idSite: z.union([z.number(), z.string()]).optional(),
            description: z.string().nullable().optional(),
            lastTimestamp: z.union([z.number(), z.string()]).nullable().optional(),
          }),
        ),
        // Some responses wrap or reshape `records`; don't fail the tool on that.
        z.unknown(),
      ])
      .optional(),
    attributes: z
      .union([
        z.array(
          z.looseObject({
            idDataAttribute: z.union([z.number(), z.string()]).optional(),
            code: z.string().optional(),
            dataType: z.string().optional(),
            formatWithUnit: z.string().nullable().optional(),
          }),
        ),
        z.unknown(),
      ])
      .optional(),
    num_records: z.union([z.number(), z.string()]).optional(),
  }),

  /**
   * GET /data-attributes. The OpenAPI response is a JSON object keyed by
   * idDataAttribute (`{ "173": { code, dataType, description, formatWithUnit } }`)
   * with no `success` wrapper. Some deployments still return `{ success, records }`.
   */
  dataAttributeCatalog: open({
    success: z.boolean().optional(),
    records: z.unknown().optional(),
    num_records: z.union([z.number(), z.string()]).optional(),
  }),

  siteIdLookup: open({
    success: z.boolean(),
    records: z
      .object({
        site_id: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
  }),

  authLogin: open({
    token: z.string().optional(),
    idUser: z.number().optional(),
    success: z.boolean().optional(),
  }),

  batteryCellSpread: open({
    success: z.boolean(),
    idSite: z.number(),
    hours: z.number(),
    start: z.number(),
    end: z.number(),
    diagnosticsRecords: z.number(),
    truncated: z.boolean(),
    batteries: z.array(
      z.looseObject({
        instance: z.number(),
        device: z.string().nullable(),
        minCellVoltageV: z.number().nullable(),
        minCellVoltageAt: z.number().nullable(),
        maxCellVoltageV: z.number().nullable(),
        maxCellVoltageAt: z.number().nullable(),
        spreadMv: z.number().nullable(),
        largestSimultaneousSpreadMv: z.number().nullable(),
        largestSimultaneousSpreadAt: z.number().nullable(),
        alignedSamples: z.number(),
        seriesSamples: z.looseObject({
          min: z.number(),
          max: z.number(),
        }),
        source: z.enum(['graph', 'diagnostics']),
        bucketSeconds: z.number().nullable(),
        simultaneousSpreadUpperBound: z.boolean(),
        minCellId: z.string().nullable(),
        maxCellId: z.string().nullable(),
        worstMinCellId: z.string().nullable(),
        worstMaxCellId: z.string().nullable(),
        latestMinCellVoltageV: z.number().nullable(),
        latestMaxCellVoltageV: z.number().nullable(),
        latestSpreadMv: z.number().nullable(),
        latestTimestamp: z.number().nullable(),
        latestBatteryVoltageV: z.number().nullable(),
        worstBatteryVoltageV: z.number().nullable(),
        soc: z.number().nullable(),
        socFormatted: z.string().nullable(),
        socCode: z.string().nullable(),
        socInstance: z.number().nullable(),
        graphError: z.string().optional(),
      }),
    ),
    timeZone: z.string().nullable(),
  }),
} as const;
