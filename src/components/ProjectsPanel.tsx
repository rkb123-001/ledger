import { useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { fmt } from "../lib/format";
import { EditableNumberInput } from "./EditableNumberInput";
import {
  projectOutlook,
  HEALTH_LABELS,
  CONFIDENCE_LABELS,
  confidenceFromSamples,
} from "../lib/predict";
import type { Project, ProjectRollup, ProjectStatus } from "../lib/types";

const STATUS_ORDER: ProjectStatus[] = ["quoted", "active", "complete", "archived"];

const STATUS_LABELS: Record<ProjectStatus, string> = {
  quoted: "Quoted",
  active: "Active",
  complete: "Complete",
  archived: "Archived",
};

interface ProjectsPanelProps {
  projects: Project[];
  rollups: ProjectRollup[];
  /** Calibration factor from budget_prediction_factor(). 1 means uncalibrated. */
  predictionFactor: number;
  /** How many closed quotes that factor rests on. */
  closedJobCount: number;
  userId: string;
  onChanged: () => void;
}

export function ProjectsPanel({
  projects,
  rollups,
  predictionFactor,
  closedJobCount,
  userId,
  onChanged,
}: ProjectsPanelProps) {
  const [showArchived, setShowArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rollupById = useMemo(() => {
    const map = new Map<string, ProjectRollup>();
    for (const r of rollups) map.set(r.project_id, r);
    return map;
  }, [rollups]);

  const visible = useMemo(() => {
    return projects
      .filter((p) => (showArchived ? true : p.status !== "archived"))
      .sort((a, b) => {
        const byStatus =
          STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
        return byStatus !== 0 ? byStatus : a.sort_order - b.sort_order;
      });
  }, [projects, showArchived]);

  const confidence = confidenceFromSamples(closedJobCount);

  async function patch(id: string, changes: Partial<Project>) {
    await supabase
      .from("budget_projects")
      .update(changes)
      .eq("id", id)
      .eq("user_id", userId);
    onChanged();
  }

  async function addProject() {
    if (busy) return;
    setBusy(true);
    const nextOrder =
      projects.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1;
    await supabase.from("budget_projects").insert({
      user_id: userId,
      name: "New project",
      status: "quoted",
      sort_order: nextOrder,
    });
    setBusy(false);
    onChanged();
  }

  async function removeProject(id: string, name: string) {
    if (
      !window.confirm(
        `Remove "${name}"? Any costs assigned to it stay in their pots and become unassigned.`
      )
    ) {
      return;
    }
    await supabase
      .from("budget_projects")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);
    onChanged();
  }

  return (
    <section className="projects-panel" aria-label="Projects">
      <div className="projects-header">
        <div>
          <h2 className="projects-title">Projects</h2>
          <div className="projects-subtitle" title={CONFIDENCE_LABELS[confidence]}>
            {predictionFactor === 1
              ? "Predictions uncalibrated until three jobs have closed"
              : `Predictions scaled by ${predictionFactor.toFixed(2)}x from ${closedJobCount} closed jobs`}
          </div>
        </div>
        <div className="projects-actions">
          <button onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
          <button className="add-btn" onClick={addProject} disabled={busy}>
            Add project
          </button>
        </div>
      </div>

      {visible.length === 0 && (
        <p className="projects-empty">
          No projects yet. Add one, then assign costs to it from any pot.
        </p>
      )}

      {visible.map((project) => {
        const rollup = rollupById.get(project.id);
        const figures = {
          budget_amount: project.budget_amount,
          committed_total: rollup?.committed_total ?? 0,
          paid_total: rollup?.paid_total ?? 0,
          estimated_total: rollup?.estimated_total ?? 0,
          quoted_production: rollup?.quoted_production ?? 0,
        };
        const outlook = projectOutlook(figures, predictionFactor);
        const pct =
          outlook.budgetUsed === null
            ? null
            : Math.min(Math.round(outlook.budgetUsed * 100), 999);

        return (
          <article key={project.id} className={`project-card health-${outlook.health}`}>
            <div className="project-top">
              {editingId === project.id ? (
                <input
                  className="project-name-edit"
                  defaultValue={project.name}
                  autoFocus
                  aria-label="Project name"
                  onBlur={(e) => {
                    const name = e.target.value.trim() || "Untitled";
                    setEditingId(null);
                    if (name !== project.name) patch(project.id, { name });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <button
                  className="project-name"
                  onClick={() => setEditingId(project.id)}
                  title="Rename"
                >
                  {project.name}
                </button>
              )}

              <select
                className="project-status"
                value={project.status}
                aria-label="Project status"
                onChange={(e) =>
                  patch(project.id, { status: e.target.value as ProjectStatus })
                }
              >
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>

              <button
                className="project-delete"
                onClick={() => removeProject(project.id, project.name)}
                aria-label={`Remove ${project.name}`}
              >
                ×
              </button>
            </div>

            <div className="project-fields">
              <label className="project-field">
                <span>Client</span>
                <input
                  type="text"
                  defaultValue={project.client_name ?? ""}
                  onBlur={(e) =>
                    patch(project.id, { client_name: e.target.value.trim() || null })
                  }
                />
              </label>
              <label className="project-field">
                <span>Budget</span>
                <EditableNumberInput
                  value={project.budget_amount ?? 0}
                  ariaLabel="Project budget"
                  onValueChange={(budget_amount) =>
                    patch(project.id, {
                      budget_amount: budget_amount === 0 ? null : budget_amount,
                    })
                  }
                />
              </label>
              <label className="project-field">
                <span>Due</span>
                <input
                  className="date-input"
                  type="date"
                  defaultValue={project.target_date ?? ""}
                  onBlur={(e) =>
                    patch(project.id, { target_date: e.target.value || null })
                  }
                />
              </label>
            </div>

            {pct !== null && (
              <div
                className="project-bar"
                role="img"
                aria-label={`${pct}% of budget predicted to be used`}
              >
                <div
                  className="project-bar-fill"
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
            )}

            <div className="project-figures">
              <div className="project-figure">
                <span>Paid</span>
                <strong>{fmt(figures.paid_total)}</strong>
              </div>
              <div className="project-figure">
                <span>Committed</span>
                <strong>{fmt(figures.committed_total)}</strong>
              </div>
              <div className="project-figure">
                <span>Predicted final</span>
                <strong>{fmt(outlook.predictedFinal)}</strong>
              </div>
              {project.budget_amount !== null && (
                <div className="project-figure">
                  <span>Remaining</span>
                  <strong
                    className={
                      (outlook.remaining ?? 0) < 0 ? "project-negative" : undefined
                    }
                  >
                    {(outlook.remaining ?? 0) < 0 ? "−" : ""}
                    {fmt(outlook.remaining ?? 0)}
                  </strong>
                </div>
              )}
            </div>

            <div className="project-footer">
              <span className={`project-health health-${outlook.health}`}>
                {HEALTH_LABELS[outlook.health]}
              </span>
              {figures.quoted_production > 0 && (
                <span className="project-variance">
                  {outlook.varianceVsQuote === 0
                    ? "Tracking the quote exactly"
                    : `${fmt(Math.abs(outlook.varianceVsQuote))} ${
                        outlook.varianceVsQuote > 0 ? "above" : "below"
                      } the ${fmt(figures.quoted_production)} quoted`}
                </span>
              )}
              {figures.estimated_total > 0 && (
                <span className="project-estimated">
                  {fmt(figures.estimated_total)} of this is still estimated
                </span>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
