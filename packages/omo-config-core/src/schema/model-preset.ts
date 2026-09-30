import * as z from "zod"

import { OmoAgentDefSchema } from "./agent"
import { OmoCategoryConfigSchema } from "./category"

/** A saved Native model setup, separate from a main-session fallback lane. */
export const OmoModelPresetSchema = z.object({
  model: z.string().min(1),
  thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  agents: z.record(z.string(), OmoAgentDefSchema).default({}),
  categories: z.record(z.string(), OmoCategoryConfigSchema).default({}),
}).strict()

export const OmoModelPresetsSchema = z.record(z.string(), OmoModelPresetSchema)
export type OmoModelPreset = z.infer<typeof OmoModelPresetSchema>
