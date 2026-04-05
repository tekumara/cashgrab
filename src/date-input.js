export function normalizeDateInput(value) {
  if (!value) return value;

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${day}/${month}/${year}`;
  }

  const dashedDayFirstMatch = value.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dashedDayFirstMatch) {
    const [, day, month, year] = dashedDayFirstMatch;
    return `${day}/${month}/${year}`;
  }

  return value;
}
