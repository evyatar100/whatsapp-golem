/**
 * Returns the timestamp in the format yymmdd-hhmmss.
 * If a date/timestamp is provided, uses that. Otherwise uses current time.
 */
export function getLogTimestamp(dateOrTimestamp?: Date | number): string {
    let now: Date;

    if (dateOrTimestamp) {
        now = typeof dateOrTimestamp === 'number' ? new Date(dateOrTimestamp) : dateOrTimestamp;
    } else {
        now = new Date();
    }

    const yy = now.getFullYear().toString().slice(-2);
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    const hh = now.getHours().toString().padStart(2, '0');
    const min = now.getMinutes().toString().padStart(2, '0');
    const ss = now.getSeconds().toString().padStart(2, '0');

    return `${yy}${mm}${dd}-${hh}${min}${ss}`;
}
