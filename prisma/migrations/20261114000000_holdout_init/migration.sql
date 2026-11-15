-- Holdout Phase 2: experiments, variants, guardrails, exposures, conversions (prisma/schema/holdout.prisma).
-- CreateEnum
CREATE TYPE "ExperimentStatus" AS ENUM ('draft', 'running', 'stopped');

-- CreateEnum
CREATE TYPE "MetricKind" AS ENUM ('proportion', 'mean');

-- CreateTable
CREATE TABLE "Experiment" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "salt" TEXT NOT NULL,
    "status" "ExperimentStatus" NOT NULL DEFAULT 'draft',
    "metricEvent" TEXT NOT NULL,
    "metricKind" "MetricKind" NOT NULL,
    "baselineRate" DOUBLE PRECISION,
    "baselineMean" DOUBLE PRECISION,
    "baselineSd" DOUBLE PRECISION,
    "mde" DOUBLE PRECISION NOT NULL,
    "alpha" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "power" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "fixedUnitsPerArm" INTEGER NOT NULL,
    "plannedUnitsPerArm" INTEGER NOT NULL,
    "plannedTotalUnits" INTEGER NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "startedAt" TIMESTAMPTZ(6),
    "stoppedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Experiment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "experimentId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guardrail" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "experimentId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "kind" "MetricKind" NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "Guardrail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exposure" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "experimentId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "unitId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Exposure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversion" (
    "id" UUID NOT NULL,
    "orgId" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Conversion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Experiment_orgId_idx" ON "Experiment"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Experiment_orgId_key_key" ON "Experiment"("orgId", "key");

-- CreateIndex
CREATE INDEX "Variant_orgId_idx" ON "Variant"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_experimentId_key_key" ON "Variant"("experimentId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_experimentId_position_key" ON "Variant"("experimentId", "position");

-- CreateIndex
CREATE INDEX "Guardrail_orgId_idx" ON "Guardrail"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Guardrail_experimentId_event_key" ON "Guardrail"("experimentId", "event");

-- CreateIndex
CREATE INDEX "Exposure_orgId_idx" ON "Exposure"("orgId");

-- CreateIndex
CREATE INDEX "Exposure_experimentId_variantId_idx" ON "Exposure"("experimentId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "Exposure_experimentId_unitId_key" ON "Exposure"("experimentId", "unitId");

-- CreateIndex
CREATE INDEX "Conversion_orgId_event_unitId_idx" ON "Conversion"("orgId", "event", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "Conversion_orgId_eventId_key" ON "Conversion"("orgId", "eventId");

-- AddForeignKey
ALTER TABLE "Experiment" ADD CONSTRAINT "Experiment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guardrail" ADD CONSTRAINT "Guardrail_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exposure" ADD CONSTRAINT "Exposure_experimentId_fkey" FOREIGN KEY ("experimentId") REFERENCES "Experiment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Exposure" ADD CONSTRAINT "Exposure_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversion" ADD CONSTRAINT "Conversion_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
