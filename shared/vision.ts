import { z } from 'zod';

export const visionSchema = z.object({
  is_outdoor: z.boolean(), category: z.enum(['bird', 'tree', 'flower', 'water', 'sky', 'other']),
  label: z.string().min(1).max(120), is_screen: z.boolean().optional(),
});
export function readVision(text: string) {
  return visionSchema.parse(JSON.parse(text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim()));
}
