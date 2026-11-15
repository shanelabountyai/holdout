-- Holdout HO-01 in the database (D-18): once an experiment leaves draft, nothing that decides a unit's bucket or the
-- analysis plan can change. assign() walks variants by position with their weights, so a ramp (new weights) or a reorder
-- would move units that were already exposed. The app refuses these edits first; these triggers make the rule hold for
-- every writer, including a hand-run SQL statement. SQLSTATE 23514 (check_violation), message prefixed "HO-01".
-- SECURITY DEFINER so the parent lookup is not hidden by RLS (a child row pointing at another org's experiment must
-- fail, not slip through because the parent is invisible).

CREATE OR REPLACE FUNCTION holdout_experiment_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'draft' THEN
    RETURN NEW;
  END IF;
  IF NEW."status" = 'draft' THEN
    RAISE EXCEPTION 'HO-01: experiment % has started and cannot return to draft', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'stopped' AND NEW."status" <> 'stopped' THEN
    RAISE EXCEPTION 'HO-01: experiment % is stopped and cannot restart', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."orgId", NEW."key", NEW."salt", NEW."metricEvent", NEW."metricKind", NEW."baselineRate", NEW."baselineMean",
      NEW."baselineSd", NEW."mde", NEW."alpha", NEW."power", NEW."fixedUnitsPerArm", NEW."plannedUnitsPerArm",
      NEW."plannedTotalUnits", NEW."startedAt", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."orgId", OLD."key", OLD."salt", OLD."metricEvent", OLD."metricKind", OLD."baselineRate", OLD."baselineMean",
      OLD."baselineSd", OLD."mde", OLD."alpha", OLD."power", OLD."fixedUnitsPerArm", OLD."plannedUnitsPerArm",
      OLD."plannedTotalUnits", OLD."startedAt", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'HO-01: experiment % has started; its key, salt, metric and plan are frozen', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER holdout_experiment_freeze BEFORE UPDATE ON "Experiment"
  FOR EACH ROW EXECUTE FUNCTION holdout_experiment_freeze();

-- Variant and Guardrail rows: no insert, update or delete under an experiment that has left draft. A row whose parent
-- is gone is being removed by the parent's cascade (deleting a draft, or deleting the org): allowed.
CREATE OR REPLACE FUNCTION holdout_design_freeze() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  parent RECORD;
  ids UUID[];
  i UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN ids := ARRAY[NEW."experimentId"];
  ELSIF TG_OP = 'DELETE' THEN ids := ARRAY[OLD."experimentId"];
  ELSE ids := ARRAY[OLD."experimentId", NEW."experimentId"];
  END IF;
  FOREACH i IN ARRAY ids LOOP
    SELECT "status", "orgId" INTO parent FROM "Experiment" WHERE "id" = i;
    IF FOUND AND parent."status" <> 'draft' THEN
      RAISE EXCEPTION 'HO-01: experiment % has started; its % rows are frozen', i, TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF TG_OP <> 'DELETE' THEN
    SELECT "orgId" INTO parent FROM "Experiment" WHERE "id" = NEW."experimentId";
    IF parent."orgId" IS DISTINCT FROM NEW."orgId" THEN
      RAISE EXCEPTION 'HO-01: % row orgId does not match its experiment', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER holdout_design_freeze BEFORE INSERT OR UPDATE OR DELETE ON "Variant"
  FOR EACH ROW EXECUTE FUNCTION holdout_design_freeze();
CREATE TRIGGER holdout_design_freeze BEFORE INSERT OR UPDATE OR DELETE ON "Guardrail"
  FOR EACH ROW EXECUTE FUNCTION holdout_design_freeze();

-- Exposure rows: only for a running experiment, with a variant of that experiment, in the same org (D-19).
-- Exposures are an append-only record of who saw what: updates are refused outright.
CREATE OR REPLACE FUNCTION holdout_exposure_check() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  e RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'HO-01: exposures are append-only' USING ERRCODE = 'check_violation';
  END IF;
  SELECT x."status", x."orgId" INTO e FROM "Experiment" x WHERE x."id" = NEW."experimentId";
  IF NOT FOUND OR e."status" <> 'running' THEN
    RAISE EXCEPTION 'HO-01: exposure for experiment % which is not running', NEW."experimentId" USING ERRCODE = 'check_violation';
  END IF;
  IF e."orgId" <> NEW."orgId" OR NOT EXISTS (SELECT 1 FROM "Variant" v WHERE v."id" = NEW."variantId" AND v."experimentId" = NEW."experimentId") THEN
    RAISE EXCEPTION 'HO-01: exposure variant or org does not match experiment %', NEW."experimentId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER holdout_exposure_check BEFORE INSERT OR UPDATE ON "Exposure"
  FOR EACH ROW EXECUTE FUNCTION holdout_exposure_check();
