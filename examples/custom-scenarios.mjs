/**
 * Custom Scenario Detectors Example
 *
 * This file demonstrates how to create custom scenario detectors
 * that extend the built-in routing logic.
 *
 * Place this file at: ~/.claude-custom-scenarios.mjs
 * (or set ROUTER_SCENARIOS_PATH to a custom path)
 *
 * The proxy will auto-load this file on startup and hot-reload on change.
 *
 * Each detector must have:
 *   - name:     Unique identifier for logging
 *   - priority: Lower = checked first (0-99 recommended)
 *   - detect:   Function(body, ctx) -> routeKey | providerId | null
 *
 * @param {Object} body - Anthropic API request body
 * @param {Object} ctx  - Detection context
 * @param {number} ctx.tokenCount - Estimated token count
 * @param {Object} ctx.config     - Current configuration
 * @param {Object} ctx.config.routes    - Route definitions
 * @param {Object} ctx.config.pools     - Load-balancing pools
 * @param {Object} ctx.config.providers - Provider configurations
 */

export const detectors = [

  // Example 1: Route code-heavy requests to a coding-specialized model
  // Detects by checking for code-related tools (Read, Edit, Write, Bash)
  {
    name: 'coding',
    priority: 15,
    detect(body, ctx) {
      if (!ctx.config.routes.coding) return null;
      const tools = body.tools || [];
      const hasCodingTools = tools.some(t =>
        t.name === 'Read' || t.name === 'Edit' ||
        t.name === 'Write' || t.name === 'Bash'
      );
      if (hasCodingTools) return 'coding';
      return null;
    },
  },

  // Example 2: Route based on time of day (e.g., use cheaper model at night)
  {
    name: 'nightMode',
    priority: 60,
    detect(body, ctx) {
      if (!ctx.config.routes.nightMode) return null;
      const hour = new Date().getHours();
      if (hour >= 22 || hour < 6) return 'nightMode';
      return null;
    },
  },

  // Example 3: Route based on specific keywords in the last user message
  {
    name: 'keyword',
    priority: 55,
    detect(body, ctx) {
      if (!ctx.config.routes.keyword) return null;
      const messages = body.messages || [];
      const lastUserMsg = messages.filter(m => m.role === 'user').pop();
      if (!lastUserMsg) return null;
      const text = typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : lastUserMsg.content?.filter(p => p.type === 'text').map(p => p.text).join(' ') || '';
      // Add your keywords here
      const keywords = ['translate', '翻译'];
      if (keywords.some(kw => text.toLowerCase().includes(kw))) {
        return 'keyword';
      }
      return null;
    },
  },

];
