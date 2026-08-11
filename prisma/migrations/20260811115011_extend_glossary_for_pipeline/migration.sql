-- AlterTable
ALTER TABLE "Glossary" ADD COLUMN     "aliases" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "lastContext" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'approved',
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'General',
ADD COLUMN     "usageNote" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "Glossary_korean_key" ON "Glossary"("korean");

-- CreateIndex
CREATE INDEX "Glossary_status_idx" ON "Glossary"("status");

