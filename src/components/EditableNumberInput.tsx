import { useEffect, useRef, useState } from "react";
import { finaliseNumber, parseDraftNumber, valueToInput } from "../lib/numbers";

interface EditableNumberInputProps {
  className?: string;
  value: unknown;
  onValueChange: (value: number) => void;
  ariaLabel?: string;
}

/**
 * A text input that reports finished numbers.
 *
 * While the field has focus it holds whatever the user has typed,
 * including states that are not yet valid numbers, and only pushes a
 * value upward once the string parses. On blur it normalises and
 * commits, so a field left as "-" settles at 0 rather than staying
 * broken. The external value is ignored while focused so a background
 * refetch cannot overwrite what someone is halfway through typing.
 */
export function EditableNumberInput({
  className,
  value,
  onValueChange,
  ariaLabel,
}: EditableNumberInputProps) {
  const [draft, setDraft] = useState(valueToInput(value));
  const isFocused = useRef(false);

  useEffect(() => {
    if (!isFocused.current) {
      setDraft(valueToInput(value));
    }
  }, [value]);

  return (
    <input
      className={className}
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={draft}
      onFocus={() => {
        isFocused.current = true;
      }}
      onChange={(event) => {
        const raw = event.target.value;
        setDraft(raw);
        const parsed = parseDraftNumber(raw);
        if (parsed !== null) {
          onValueChange(parsed);
        }
      }}
      onBlur={() => {
        const nextValue = finaliseNumber(draft);
        setDraft(valueToInput(nextValue));
        onValueChange(nextValue);
        isFocused.current = false;
      }}
    />
  );
}
