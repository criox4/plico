-- Push notifications: devices, preferences and the outbox. splittr schema only.
ALTER TABLE "splittr"."user" ADD COLUMN "notify" JSONB, ADD COLUMN "tz" TEXT;

CREATE TABLE "splittr"."push_device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "keys" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "push_device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "push_device_token_key" ON "splittr"."push_device"("token");
CREATE INDEX "push_device_userId_idx" ON "splittr"."push_device"("userId");
CREATE INDEX "push_device_sessionId_idx" ON "splittr"."push_device"("sessionId");
ALTER TABLE "splittr"."push_device" ADD CONSTRAINT "push_device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "splittr"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "splittr"."push_device" ADD CONSTRAINT "push_device_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "splittr"."session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "splittr"."notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "groupId" TEXT,
    "byId" TEXT,
    "data" JSONB NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "skipped" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "notification_sentAt_dueAt_idx" ON "splittr"."notification"("sentAt", "dueAt");
CREATE INDEX "notification_userId_createdAt_idx" ON "splittr"."notification"("userId", "createdAt");
CREATE INDEX "notification_groupId_kind_createdAt_idx" ON "splittr"."notification"("groupId", "kind", "createdAt");
ALTER TABLE "splittr"."notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "splittr"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
