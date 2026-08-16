import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

// Web Push (backlog I): one row per browser push subscription, owned by a board
// user within a company. The push endpoint is globally unique to a browser
// subscription, so it is the natural conflict/ownership key. No RLS — Paperclip
// scopes access at the application layer (companyId + userId + route guards),
// consistent with every other table here.
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    expirationTime: timestamp("expiration_time", { withTimezone: true }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUserIdx: index("push_subscriptions_company_user_idx").on(table.companyId, table.userId),
    endpointUnique: uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
  }),
);
