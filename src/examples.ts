import { useEffect } from 'react';
import { useStableCallback } from './ui';

export type ExampleTarget = 'http' | 'grpc' | 'redis' | 'utils';

export const EXAMPLES = {
  http: { method: 'GET', url: 'https://httpbin.org/get', query: [{ key: 'hello', value: 'conduit' }] },
  grpc: { host: 'grpcb.in', port: '9000', plaintext: true },
  redis: { host: '127.0.0.1', port: '6379' },
  db: { driver: 'postgres' as const, url: 'postgres://postgres:postgres@localhost:5432/postgres', query: 'SELECT now(), version();' },
  ws: { url: 'wss://echo.websocket.org' },
  utils: { template: 'hmac' },
};

const handlers = new Map<ExampleTarget, (data: unknown) => void>();

export function runExample(target: ExampleTarget, data: unknown = EXAMPLES[target]) {
  handlers.get(target)?.(data);
}

export function useExample<T>(target: ExampleTarget, fn: (data: T) => void) {
  const stable = useStableCallback(fn as (d: unknown) => void);
  useEffect(() => {
    handlers.set(target, stable);
    return () => {
      if (handlers.get(target) === stable) handlers.delete(target);
    };
  }, [target, stable]);
}
