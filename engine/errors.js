// Typed error carried from engine/API to HTTP responses.
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const isApiError = (e) => e && e.name === 'ApiError' && typeof e.status === 'number';
