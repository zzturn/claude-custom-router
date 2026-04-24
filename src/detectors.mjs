/**
 * Scenario detectors for claude-custom-router.
 *
 * Each detector examines the request body and context to determine
 * if a specific routing scenario applies.
 */

/**
 * Model families detected from Claude model IDs, ordered by specificity.
 * Opus checked first to avoid "sonnet" matching inside compound names.
 */
export const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku'];

/**
 * Detects explicit model override via comma-separated model IDs.
 * e.g., "original-model,my-provider" routes to "my-provider"
 */
export function detectExplicitModel(body, ctx) {
  if (body.model && body.model.includes(',')) {
    const modelId = body.model;
    if (ctx.config.providers[modelId]) return modelId;
    const afterComma = body.model.split(',').slice(1).join(',');
    if (ctx.config.providers[afterComma]) return afterComma;
    return modelId;
  }
  return null;
}

/**
 * Detects model family from the Claude model ID in the request.
 * Maps body.model (e.g., "claude-sonnet-4-6") to routes.haiku/sonnet/opus config.
 */
export function detectModelFamily(body, ctx) {
  if (!body.model) return null;
  const modelLower = body.model.toLowerCase();
  for (const family of MODEL_FAMILIES) {
    if (modelLower.includes(family) && ctx.config.routes[family]) {
      return family;
    }
  }
  return null;
}

/**
 * Detects image/vision requests by scanning recent messages for image content.
 * Only checks the last few user messages to avoid unnecessary scanning.
 */
export function detectImage(body, ctx) {
  if (!ctx.config.routes.image) return null;
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    if (typeof msg.content === 'string') continue;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image' || part.type === 'image_url') {
          return 'image';
        }
      }
    }
  }
  return null;
}
