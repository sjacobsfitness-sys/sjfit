import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// Tiny JSON-file order store. Fine for a one-coach business; swap for a DB later.
export class OrderStore {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'orders.json');
  }

  all() {
    if (!existsSync(this.file)) return [];
    return JSON.parse(readFileSync(this.file, 'utf8'));
  }

  save(orders) {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(orders, null, 2));
    renameSync(tmp, this.file);
  }

  add(order) {
    const orders = this.all();
    orders.unshift(order);
    this.save(orders);
    return order;
  }

  findBySessionId(sessionId) {
    return this.all().find((o) => o.truemedSessionId === sessionId);
  }

  update(sessionId, patch) {
    const orders = this.all();
    const order = orders.find((o) => o.truemedSessionId === sessionId);
    if (!order) return undefined;
    Object.assign(order, patch, { updatedAt: new Date().toISOString() });
    this.save(orders);
    return order;
  }
}
