import type { ReactNode } from 'react';

export function Banner(props: { kind: 'err' | 'warn' | 'ok' | 'info'; children: ReactNode; testId?: string }) {
  return (
    <div className={`banner ${props.kind}`} data-testid={props.testId}>
      {props.children}
    </div>
  );
}
