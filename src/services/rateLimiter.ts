
export class RateLimiter {
    private requests: Map<string, number[]> = new Map();
    private limit: number;
    private windowMs: number;

    constructor(limit: number = 10, windowHour: number = 1) {
        this.limit = limit;
        this.windowMs = windowHour * 60 * 60 * 1000;
    }

    public canRequest(userId: string): boolean {
        const now = Date.now();
        const timestamps = this.requests.get(userId) || [];

        // Filter out old requests
        const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);

        if (validTimestamps.length >= this.limit) {
            return false;
        }

        validTimestamps.push(now);
        this.requests.set(userId, validTimestamps);
        return true;
    }

    public getRemaining(userId: string): number {
        const now = Date.now();
        const timestamps = this.requests.get(userId) || [];
        const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs);
        return this.limit - validTimestamps.length;
    }
}
