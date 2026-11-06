// True/false questions: two options that are both yes/no words.

const TF_WORDS = new Set([
  'true', 'false', 'верно', 'неверно', 'да', 'нет', 'правда', 'ложь', 'истина', 'yes', 'no',
]);

export function isTrueFalse(options: string[]): boolean {
  return (
    options.length === 2 &&
    options.every((o) => TF_WORDS.has(o.toLowerCase().replace(/[.!]$/, '').trim()))
  );
}
