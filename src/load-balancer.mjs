/**
 * Load Balancer module for claude-custom-router
 *
 * Provides connection tracking, pluggable strategies, and provider selection
 * for load-balanced routing groups.
 */

/**
 * Pluggable load balancing strategies.
 * Each strategy receives (providers, ctx) and returns a providerId or null.
 * @type {Record<string, (providers: Array<{provider: string, maxConns: number}>, ctx: { getConns: (id: string) => number }) => string|null>}
 */
export const strategies = {
  'priority-fallback': (providers, ctx) => {
    if (!providers || providers.length === 0) return null;
    for (const p of providers) {
      if (ctx.getConns(p.provider) < p.maxConns) return p.provider;
    }
    // fail-open: use first provider when all at capacity
    return providers[0].provider;
  },
};

/** Active connection counts per provider: providerId -> number */
export const activeConns = new Map();

/** Per-pool state for strategies (e.g., round-robin counters): poolKey -> any */
export const lbState = new Map();

export function incConn(providerId) {
  activeConns.set(providerId, (activeConns.get(providerId) || 0) + 1);
}

export function decConn(providerId) {
  const cur = activeConns.get(providerId) || 0;
  activeConns.set(providerId, Math.max(0, cur - 1));
}

export function getConns(providerId) {
  return activeConns.get(providerId) || 0;
}

/**
 * Selects a provider from a load-balancing pool using the configured strategy.
 * @param {string} poolKey - Pool identifier
 * @param {{ strategy: string, providers: Array<{provider: string, maxConns: number}> }} pool
 * @param {{ warn: (msg: string) => void }} logger - Logger instance
 * @returns {string|null} Selected providerId
 */
export function selectProvider(poolKey, pool, logger) {
  const strategy = strategies[pool.strategy];
  if (!strategy) {
    logger.warn(`Unknown LB strategy "${pool.strategy}" for "${poolKey}", using priority-fallback`);
    return strategies['priority-fallback'](pool.providers, { getConns });
  }
  return strategy(pool.providers, { getConns });
}

/**
 * Creates a connection tracker with once-guard to prevent double-decrement.
 * @param {string} providerId - Provider to track
 * @returns {{ cleanup: () => void, providerId: string }}
 */
export function withConnTracking(providerId) {
  incConn(providerId);
  let cleaned = false;
  return {
    cleanup: () => {
      if (!cleaned) { cleaned = true; decConn(providerId); }
    },
    providerId,
  };
}
