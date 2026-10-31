export type EngineErrorCode =
  | 'invalid_board'
  | 'invalid_setup'
  | 'unknown_action'
  | 'invalid_phase'
  | 'wrong_player'
  | 'insufficient_cash';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}
