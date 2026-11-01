export type EngineErrorCode =
  | 'invalid_board'
  | 'invalid_setup'
  | 'unknown_action'
  | 'invalid_phase'
  | 'wrong_player'
  | 'insufficient_cash'
  /** The action points at something that is not a valid target (wrong tile kind, out of range). */
  | 'invalid_target'
  /** The action is well formed but a game rule forbids it (not the owner, already built, ...). */
  | 'not_allowed';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
