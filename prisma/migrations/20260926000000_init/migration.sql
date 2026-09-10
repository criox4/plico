-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "splittr";

-- CreateTable
CREATE TABLE "splittr"."user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "upi" TEXT,
    "theme" TEXT DEFAULT 'classic',
    "tone" TEXT DEFAULT 'gentle',

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splittr"."session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splittr"."account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splittr"."verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splittr"."group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "track" BOOLEAN NOT NULL DEFAULT false,
    "inviteCode" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splittr"."member" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "upi" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splittr"."expense" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "cat" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "mode" TEXT,
    "input" JSONB,
    "settle" BOOLEAN NOT NULL DEFAULT false,
    "repeatNext" TEXT,
    "repeatDay" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "splittr"."expense_share" (
    "expenseId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "paid" INTEGER NOT NULL DEFAULT 0,
    "owed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "expense_share_pkey" PRIMARY KEY ("expenseId","memberId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "splittr"."user"("email");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "splittr"."session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "splittr"."session"("token");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "splittr"."account"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "splittr"."verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "group_inviteCode_key" ON "splittr"."group"("inviteCode");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "splittr"."member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "member_groupId_userId_key" ON "splittr"."member"("groupId", "userId");

-- CreateIndex
CREATE INDEX "expense_groupId_idx" ON "splittr"."expense"("groupId");

-- CreateIndex
CREATE INDEX "expense_share_memberId_idx" ON "splittr"."expense_share"("memberId");

-- AddForeignKey
ALTER TABLE "splittr"."session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "splittr"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splittr"."account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "splittr"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splittr"."group" ADD CONSTRAINT "group_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "splittr"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splittr"."member" ADD CONSTRAINT "member_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "splittr"."group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splittr"."member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "splittr"."user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splittr"."expense" ADD CONSTRAINT "expense_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "splittr"."group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splittr"."expense_share" ADD CONSTRAINT "expense_share_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "splittr"."expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "splittr"."expense_share" ADD CONSTRAINT "expense_share_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "splittr"."member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

