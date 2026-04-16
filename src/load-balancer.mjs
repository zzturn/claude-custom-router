/**
 * Load Balancer module for claude-custom-router
 *
 * Provides connection tracking, pluggable strategies, and provider selection
 * for load-balanced routing groups.
 */

/**
 * Pluggable load balancing strategies.
 * Each strategy receives (providers, ctx) and returns a providerId or null.
 * @type {Record<string, (providers: Array<{id: string, maxConns: number}>, ctx: { getConns: (id: string) => number }) => string|null>}
 */
export const strategies = {
  'priority-fallback': (providers, ctx) => {
    if (!providers || providers.length === 0) return null;
    for (const p of providers) {
      if (ctx.getConns(p.id) < p.maxConns) return p.id;
    }
    // fail-open: use first provider when all at capacity
    return providers[0].id;
  },
};

/** Active connection counts per provider: providerId -> number */
export const activeConns = new Map();

/** Per-group state for strategies (e.g., round-robin counters): groupKey -> any */
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
 * Selects a provider from a LB group using the configured strategy.
 * @param {string} groupKey - Router key identifying the LB group
 * @param {{ strategy: string, providers: Array<{id: string, maxConns: number}> }} group
 * @param {{ warn: (msg: string) => void }} logger - Logger instance
 * @returns {string|null} Selected providerId
 */
export function selectProvider(groupKey, group, logger) {
  const strategy = strategies[group.strategy];
  if (!strategy) {
    logger.warn(`Unknown LB strategy "${group.strategy}" for "${groupKey}", using priority-fallback`);
    return strategies['priority-fallback'](group.providers, { getConns });
  }
  return strategy(group.providers, { getConns });
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
