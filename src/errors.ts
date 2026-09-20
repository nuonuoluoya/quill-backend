import { HttpException } from '@nestjs/common';
export class Fault extends HttpException {
  constructor(
    status: number,
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super({ code, message, details }, status);
  }
}
export const fail = (ok: unknown, status: number, code: string, message: string): asserts ok => {
  if (!ok) throw new Fault(status, code, message);
};
export function required<T>(value: T | null | undefined, code = 'INVALID_REQUEST'): T {
  if (value === null || value === undefined) throw new Fault(400, code, '请求参数不完整');
  return value;
}
