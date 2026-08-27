import { useRef, useState } from "react";
import { supabase } from "../lib/supabase";

interface UploadProps {
  onParsed: () => void;
}

export function ScreenshotUpload({ onParsed }: UploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleFile(file: File) {
    setError("");
    setStatus("Reading file...");
    setBusy(true);

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          const stripped = result.split(",")[1];
          resolve(stripped);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });

      setStatus("Sending to parser...");

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error("Not signed in");
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
      const response = await fetch(`${supabaseUrl}/functions/v1/parse-screenshot`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: base64,
          mediaType: file.type || "image/png",
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Parse failed");
      }

      const count = result.items?.length ?? 0;
      setStatus(`Found ${count} draft${count === 1 ? "" : "s"}. Review below.`);
      onParsed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <div className="upload-section">
      <div className="upload-title">Add from screenshot</div>
      <div className="upload-description">
        Add a list of calculated items that need sorting into your budget. They appear as drafts to review before anything is added.
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png, image/jpeg, image/webp, image/heic, image/heif"
        capture="environment"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
      <button
        className="upload-button"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
      >
        {busy ? "Processing..." : "Upload screenshot"}
      </button>
      {status && <div className="upload-status">{status}</div>}
      {error && <div className="upload-status upload-error">{error}</div>}
    </div>
  );
}
