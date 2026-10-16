/** Node half; the optional mobile controller owns all Host behavior. */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'

export { Config } from './config.ts'
/**
 * Declare configuration for the Client-only plugin registration.
 * @param _ctx - Loader context; this entry registers no Host behavior.
 * @param _config - validated settings forwarded to the Client composition.
 */
export function apply(_ctx: Context, _config: Config): void {}
