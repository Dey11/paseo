import { describe, expect, it } from "vitest";
import { resolveCliInstallSourcePath } from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/HanabiCode.app/Contents/MacOS/HanabiCode",
        shimPath: "/Applications/HanabiCode.app/Contents/Resources/bin/hanabicode",
      }),
    ).toBe("/Applications/HanabiCode.app/Contents/Resources/bin/hanabicode");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_hanabi123/hanabicode",
        shimPath: "/tmp/.mount_hanabi123/resources/bin/hanabicode",
        appImagePath: "/home/user/Applications/HanabiCode.AppImage",
      }),
    ).toBe("/home/user/Applications/HanabiCode.AppImage");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\HanabiCode\\HanabiCode.exe",
        shimPath:
          "C:\\Users\\user\\AppData\\Local\\Programs\\HanabiCode\\resources\\bin\\hanabicode.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\HanabiCode\\resources\\bin\\hanabicode.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/HanabiCode/hanabicode",
        shimPath: "/opt/HanabiCode/resources/bin/hanabicode",
      }),
    ).toBe("/opt/HanabiCode/resources/bin/hanabicode");
  });
});
