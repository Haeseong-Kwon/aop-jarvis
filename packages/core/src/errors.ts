export type ErrorCode =
  | 'VOICE_ENGINE_ERROR'
  | 'MODEL_PROVIDER_OFFLINE'
  | 'TOOL_PERMISSION_DENIED'
  | 'TASK_EXECUTION_FAILED'
  | 'MEMORY_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED'
  | 'CANCELLED'

export class JarvisError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'JarvisError'
  }
}

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new JarvisError('CANCELLED', 'Cancelled')
}
