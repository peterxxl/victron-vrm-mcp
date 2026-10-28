import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  READ_ONLY_ANNOTATIONS,
  assertSiteAllowed,
  formatVrmError,
  idSiteSchema,
  instanceSchema,
  resolveAuth,
  sitePath,
} from './helpers.js';
import { formatGraphText, formatWidgetText } from './present.js';
import { lookupSiteTimeZone } from './site_time.js';
import type { QueryValue, VrmClient } from '../vrm/client.js';
import { outputSchemas } from './output_schemas.js';

const unixTsSchema = z
  .number()
  .int()
  .min(0)
  .max(10_000_000_000)
  .optional()
  .describe('Unix timestamp (seconds).');

interface VrmGraphResponse {
  success: boolean;
  records?: {
    data?: Record<string, Array<number[]>>;
    meta?: Record<string, { code: string; description: string }>;
  };
}

interface VrmStateResponse {
  success: boolean;
  records?: unknown;
}

async function fetchWidget<T>(
  client: VrmClient,
  idSite: number,
  widget: string,
  query: Record<string, QueryValue | undefined>,
): Promise<T> {
  return client.get<T>(sitePath(idSite, `widgets/${encodeURIComponent(widget)}`), query);
}

export function registerWidgetsTools(server: McpServer): void {
  server.registerTool(
    'vrm_widget_graph',
    {
      title: 'Graph widget — time-series data',
      description:
        'Fetch graph time-series data for one or more data attributes on a VRM installation. Attributes can be given by code (strings) or id (integers) or both. If no timeframe is provided, the last 24 hours are returned. Text output lists, per attribute, the sample count, min, max, last, the timestamps of the min and max, and a compact series. Set includePoints true to list every sample. Endpoint: GET /installations/{idSite}/widgets/Graph.',
      inputSchema: {
        idSite: idSiteSchema,
        attributeCodes: z.array(z.string().min(1).max(32)).max(20).optional().describe('Attribute codes, e.g. ["bs","bv"].'),
        attributeIds: z.array(z.number().int().positive()).max(20).optional().describe('Attribute ids, e.g. [142, 145].'),
        instance: instanceSchema.optional().describe('Device instance. CAN-bus BMS batteries are often 512+. Default 0.'),
        start: unixTsSchema,
        end: unixTsSchema,
        width: z.number().int().min(64).max(8192).optional().describe('Graph width in pixels (default 768).'),
        pointsPerPixel: z.number().min(0.1).max(10).optional().describe('Datapoints per pixel (default 2).'),
        useMinMax: z.boolean().optional().describe('If true, include min/max per point alongside the mean.'),
        includePoints: z
          .boolean()
          .optional()
          .describe('When true, the text output lists every sample. Default is a compact series (about 12 samples) plus min/max/last.'),
      },
      outputSchema: outputSchemas.widgetGraph,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ idSite, attributeCodes, attributeIds, instance, start, end, width, pointsPerPixel, useMinMax, includePoints }, extra) => {
      const auth = resolveAuth(extra);
      if (!auth.ok) {
        return auth.error;
      }
      try {
        assertSiteAllowed(idSite);

        const query: Record<string, QueryValue | undefined> = {
          instance,
          start,
          end,
          width,
          pointsPerPixel,
          useMinMax: useMinMax === undefined ? undefined : useMinMax ? 1 : 0,
        };
        if (attributeCodes && attributeCodes.length > 0) {
          query['attributeCodes[]'] = attributeCodes;
        }
        if (attributeIds && attributeIds.length > 0) {
          query['attributeIds[]'] = attributeIds;
        }

        const data = await fetchWidget<VrmGraphResponse>(auth.client, idSite, 'Graph', query);
        const timeZone = await lookupSiteTimeZone(auth.client, idSite);

        return {
          content: [{ type: 'text', text: formatGraphText(idSite, data, { includePoints, timeZone }) }],
          structuredContent: data as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return formatVrmError(error);
      }
    },
  );

  server.registerTool(
    'vrm_widget',
    {
      title: 'Generic widget fetcher',
      description:
        'Fetch any VRM widget by name — BatterySummary, SolarChargerSummary, TankSummary, VeBusState, EvChargerSummary, MPPTState, InputState, InverterState, PVInverterStatus, MotorSummary, MeteorologicalSensorOverview, GlobalLinkSummary, Status, HoursOfAc, LithiumBMS, DCMeter, FuelCellState, BatteryRelayState, BatteryExternalRelayState, ChargerRelayState, GatewayRelayState, GatewayRelayTwoState, SolarChargerRelayState, BatteryMonitorWarningsAndAlarms, VeBusWarningsAndAlarms, InverterChargerState, InverterChargerWarningsAndAlarms, EssBatteryLifeState, IOExtenderInOut, BMSDiagnostics, HistoricData, TempSummaryAndGraph, TempAirQuality. Text lists each reading with value, unit, and formatted value. Endpoint: GET /installations/{idSite}/widgets/{widget}.',
      inputSchema: {
        idSite: idSiteSchema,
        widget: z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9]*$/).describe('Widget name — PascalCase identifier, letters/digits only.'),
        instance: instanceSchema.optional().describe('Device instance. CAN-bus BMS batteries are often 512+. Default 0.'),
        start: unixTsSchema,
        end: unixTsSchema,
      },
      outputSchema: outputSchemas.widget,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ idSite, widget, instance, start, end }, extra) => {
      const auth = resolveAuth(extra);
      if (!auth.ok) {
        return auth.error;
      }
      try {
        assertSiteAllowed(idSite);
        const data = await fetchWidget<VrmStateResponse>(auth.client, idSite, widget, {
          instance,
          start,
          end,
        });
        const timeZone = await lookupSiteTimeZone(auth.client, idSite);
        return {
          content: [{ type: 'text', text: formatWidgetText(idSite, widget, data, { timeZone }) }],
          structuredContent: data as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return formatVrmError(error);
      }
    },
  );

  server.registerTool(
    'vrm_widget_generator_state',
    {
      title: 'Generator state widget',
      description:
        'Fetch generator state-change data for a VRM installation over a given timeframe (default: last 24 hours). Endpoint: GET /installations/{idSite}/widgets/GeneratorState.',
      inputSchema: {
        idSite: idSiteSchema,
        instance: instanceSchema.optional().describe('Device instance. CAN-bus BMS batteries are often 512+. Default 0.'),
        start: unixTsSchema,
        end: unixTsSchema,
      },
      outputSchema: outputSchemas.widget,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ idSite, instance, start, end }, extra) => {
      const auth = resolveAuth(extra);
      if (!auth.ok) {
        return auth.error;
      }
      try {
        assertSiteAllowed(idSite);
        const data = await fetchWidget<VrmStateResponse>(auth.client, idSite, 'GeneratorState', {
          instance,
          start,
          end,
        });
        const timeZone = await lookupSiteTimeZone(auth.client, idSite);

        return {
          content: [{ type: 'text', text: formatWidgetText(idSite, 'GeneratorState', data, { timeZone }) }],
          structuredContent: data as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return formatVrmError(error);
      }
    },
  );
}
