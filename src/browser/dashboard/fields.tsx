import type { ReactNode } from 'react';
import { Field as FormField, FieldLabel, FieldDescription } from '../components/ui/field.js';

export function Field({
  label,
  id,
  children,
  hint,
}: {
  label: string;
  id: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <FormField>
      <FieldLabel htmlFor={id} className="text-xs text-secondary-foreground">
        {label}
      </FieldLabel>
      {children}
      {hint ? <FieldDescription className="text-[11px] leading-5">{hint}</FieldDescription> : null}
    </FormField>
  );
}

export function Step({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border bg-muted/40 text-[10px] text-secondary-foreground">
        {number}
      </span>
      <div className="grid min-w-0 gap-3 text-xs text-muted-foreground [&>p]:leading-6">
        <h3 className="font-medium text-foreground">{title}</h3>
        {children}
      </div>
    </div>
  );
}
