/** 外部の message / stack / stdout / stderr は信用せず、固定コードだけを公開する。 */
export function errorCode(error: unknown): string {
  const allowed = new Set([
    'NoSuchKey', 'AccessDenied', 'PreconditionFailed', 'ConditionalRequestConflict',
    'LockConflictError', 'InvalidConfiguration', 'InvalidInput',
    'CertbotRegistrationFailed', 'CertbotExecutionFailed',
  ]);
  const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
  return typeof name === 'string' && allowed.has(name) ? name : 'OperationFailed';
}

export function failure(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
