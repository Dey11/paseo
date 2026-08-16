/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { useCallback, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortErrorAlert } from "./port-error-alert";

void testI18n;

function ErrorHarness({ onRetry }: { onRetry?: () => void }) {
  const [message, setMessage] = useState("relay connection failed");
  const dismiss = useCallback(() => setMessage(""), []);
  return message ? (
    <PortErrorAlert
      testID="port-error"
      title="Unable to forward port"
      message={message}
      onRetry={onRetry}
      onDismiss={dismiss}
    />
  ) : null;
}

describe("PortErrorAlert", () => {
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a failed operation visible while the user retries", () => {
    const retry = vi.fn();
    render(<ErrorHarness onRetry={retry} />);

    expect(screen.getByRole("alert").textContent).toContain("relay connection failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("relay connection failed");
  });

  it("removes a persistent failure only after explicit dismissal", () => {
    render(<ErrorHarness />);

    expect(screen.getByRole("alert")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
