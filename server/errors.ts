export class AppError extends Error {
  constructor(public status: number, public reason: string, message: string, public suggestMode?: string) { super(message); }
}
export const limitError = (kind: string) => new AppError(429, kind, kind.includes('burst') ? 'Give your buddy a moment to think.' : kind === 'places' ? 'Try a saved spot or open Maps.' : kind === 'memory' ? 'Your field notes are full. Clear some memories to make room.' : 'Please try again in a little while.');
