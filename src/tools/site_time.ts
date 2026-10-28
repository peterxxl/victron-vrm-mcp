import type { VrmClient } from '../vrm/client.js';

/**
 * Installation IANA timezone from GET /users/me and
 * GET /users/{idUser}/installations (the record's `timezone` field).
 * Failures return null so a missing timezone never fails the read.
 */

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<number, { zone: string | null; at: number }>();

export function clearSiteTimeZoneCache(): void {
  cache.clear();
}

export function isIanaTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export async function lookupSiteTimeZone(client: VrmClient, idSite: number): Promise<string | null> {
  const caching = process.env['VITEST'] !== 'true';
  if (caching) {
    const hit = cache.get(idSite);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return hit.zone;
    }
  }
  try {
    const me = await client.get<{ user?: { id?: number } }>('/users/me');
    const idUser = me.user?.id;
    if (typeof idUser !== 'number' || !Number.isInteger(idUser) || idUser <= 0) {
      return remember(idSite, null, caching);
    }
    const body = await client.get<{ records?: Array<{ idSite?: number; timezone?: unknown }> }>(
      `/users/${encodeURIComponent(String(idUser))}/installations`,
      { extended: 1 },
    );
    const site = (body.records ?? []).find((row) => Number(row.idSite) === idSite);
    const raw = site?.timezone;
    const zone = typeof raw === 'string' && isIanaTimeZone(raw) ? raw : null;
    return remember(idSite, zone, caching);
  } catch {
    return null;
  }
}

function remember(idSite: number, zone: string | null, caching: boolean): string | null {
  if (caching) {
    cache.set(idSite, { zone, at: Date.now() });
  }
  return zone;
}
