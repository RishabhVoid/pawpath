import { z } from 'zod';

export const visionSchema = z.object({
  is_outdoor: z.boolean(), category: z.preprocess(value => typeof value === 'string' ? value.trim().toLowerCase() : value, z.enum(['bird', 'tree', 'flower', 'water', 'sky', 'other']).catch('other')),
  label: z.string().trim().min(1).max(120), is_screen: z.boolean().optional(),
});
export function readVision(text: string) {
  try { return visionSchema.parse(JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim())); }
  catch { throw new Error('Gemma could not read that discovery. Try a clearer outdoor photo.'); }
}
