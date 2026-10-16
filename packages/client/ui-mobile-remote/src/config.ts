/** Polling policy for the desktop authorization view. */
import z from '@deepseek-ai/schemastery'

/** Client status refresh policy. */
export interface Config {
  /** Interval in milliseconds between nonoverlapping authorization status reads. */
  readonly pollMs: number
}
/** Validated polling cadence; idle, unopened views perform no reads. */
export const Config: z<Config> = z.object({ pollMs: z.natural().min(500).max(10000).default(2000) })
