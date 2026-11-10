import type { MediaType } from './types';

let csrfToken: string | null = null;
export function setCsrfToken(token: string | null) { csrfToken = token; }

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

export function reportSessionStatus(status: number) {
  if (status === 401 || status === 423) {
    window.dispatchEvent(new CustomEvent('session-needed', { detail: status }));
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof Blob)) headers.set('Content-Type', 'application/json');
  if (init.method && init.method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const result = await fetch(`/api/v1${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store' });
  if (!result.ok) {
    reportSessionStatus(result.status);
    const error = await result.json().catch(() => ({ code: 'request_failed' })) as { code?: string };
    throw new ApiError(result.status, error.code ?? 'request_failed');
  }
  if (result.status === 204) {
    if (!init.method || init.method === 'GET') throw new ApiError(502, 'empty_response');
    return undefined as T;
  }
  const text = await result.text();
  if (!text && (!init.method || init.method === 'GET')) throw new ApiError(502, 'empty_response');
  return text ? JSON.parse(text) as T : undefined as T;
}

export function mutate<T>(path: string, method: string, body?: unknown) {
  return api<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function postJsonStream<T>(path: string, body: unknown, onEvent: (event: T) => void): Promise<void> {
  const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/x-ndjson' });
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const result = await fetch(`/api/v1${path}`, {
    method: 'POST', body: JSON.stringify(body), headers, credentials: 'same-origin', cache: 'no-store',
  });
  if (!result.ok) {
    reportSessionStatus(result.status);
    const error = await result.json().catch(() => ({ code: 'request_failed' })) as { code?: string };
    throw new ApiError(result.status, error.code ?? 'request_failed');
  }
  if (!result.body || !result.headers.get('Content-Type')?.includes('application/x-ndjson'))
    throw new ApiError(502, 'incomplete_storage_move');
  const reader = result.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  function dispatch(line: string) {
    if (!line.trim()) return;
    let event: T;
    try { event = JSON.parse(line) as T; }
    catch { throw new ApiError(502, 'incomplete_storage_move'); }
    onEvent(event);
  }
  try {
    for (;;) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 1024 * 1024) throw new ApiError(502, 'incomplete_storage_move');
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        dispatch(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (chunk.done) { dispatch(pending); break; }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'incomplete_storage_move');
  } finally {
    await reader.cancel().catch(() => { /* A disconnected server has already closed the stream. */ });
    reader.releaseLock();
  }
}

export function upload<T>(file: File, type: MediaType, title: string, tags: string, onProgress: (value: number) => void) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    const query = new URLSearchParams({ fileName: file.name, type, title, tags });
    xhr.open('POST', `/api/v1/imports?${query}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (csrfToken) xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText) as T); } catch { reject(new ApiError(500, 'request_failed')); }
      } else {
        reportSessionStatus(xhr.status);
        let code = 'request_failed';
        try { code = (JSON.parse(xhr.responseText) as { code: string }).code; } catch { /* generic error */ }
        reject(new ApiError(xhr.status, code));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error'));
    xhr.onabort = () => reject(new ApiError(0, 'cancelled'));
    xhr.send(file);
  });
  return { promise, cancel: () => xhr.abort() };
}

export const streamUrl = (id: string) => `/api/v1/media/${encodeURIComponent(id)}/stream`;
export const posterUrl = (id: string, version: string) => `/api/v1/media/${encodeURIComponent(id)}/poster?v=${encodeURIComponent(version)}`;
