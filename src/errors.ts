// Every failure in foxpack is a FoxpackError with a code that a caller can
// check. The message says what went wrong in words.
export type FoxpackErrorCode =
  | "bad_input"
  | "bad_export"
  | "corrupt_zip"
  | "too_large"
  | "not_found"
  | "corrupt_store"
  | "locked";

export class FoxpackError extends Error {
  readonly code: FoxpackErrorCode;
  constructor(code: FoxpackErrorCode, message: string) {
    super(message);
    this.name = "FoxpackError";
    this.code = code;
  }
}
