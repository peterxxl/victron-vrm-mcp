import { describe, it, expect } from 'vitest';
import { isIanaTimeZone, lookupSiteTimeZone } from '../src/tools/site_time.js';
import type { VrmClient } from '../src/vrm/client.js';

function client(routes: Record<string, unknown>): VrmClient {
  return {
    get: async (path: string) => {
      if (path in routes) {
        return routes[path];
      }
      throw new Error(`unexpected ${path}`);
    },
  } as VrmClient;
}

describe('site timezone lookup', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isIanaTimeZone('Europe/Prague')).toBe(true);
    expect(isIanaTimeZone('Nope/Nope')).toBe(false);
  });

  it('reads timezone from the installations list and ignores a missing site', async () => {
    const api = client({
      '/users/me': { user: { id: 22 } },
      '/users/22/installations': {
        records: [
          { idSite: 216772, timezone: 'Europe/Prague' },
          { idSite: 6, timezone: 'Nope/Nope' },
        ],
      },
    });
    expect(await lookupSiteTimeZone(api, 216772)).toBe('Europe/Prague');
    expect(await lookupSiteTimeZone(api, 6)).toBeNull();
    expect(await lookupSiteTimeZone(api, 9)).toBeNull();
  });

  it('returns null when the installations call fails', async () => {
    const api = client({ '/users/me': { user: { id: 22 } } });
    expect(await lookupSiteTimeZone(api, 1)).toBeNull();
  });
});
