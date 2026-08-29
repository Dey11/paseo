import { useCallback } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { GitFork, Scale } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { GitHubIcon } from "@/components/icons/github-icon";
import { openExternalUrl } from "@/utils/open-external-url";
import { EXACT_SOURCE_URL, LICENSE_URL, UPSTREAM_REPOSITORY_URL } from "@/constants/product";

const renderGitHubIcon = (color: string) => <GitHubIcon color={color} size={14} />;
export function CommunityLinks() {
  const handleOpenSource = useCallback(() => {
    void openExternalUrl(EXACT_SOURCE_URL);
  }, []);

  const handleOpenLicense = useCallback(() => {
    void openExternalUrl(LICENSE_URL);
  }, []);

  const handleOpenUpstream = useCallback(() => {
    void openExternalUrl(UPSTREAM_REPOSITORY_URL);
  }, []);

  return (
    <View style={styles.row}>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={renderGitHubIcon}
        onPress={handleOpenSource}
        testID="community-links-source"
      >
        Source
      </Button>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={Scale}
        onPress={handleOpenLicense}
        testID="community-links-license"
      >
        Apache license
      </Button>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={GitFork}
        onPress={handleOpenUpstream}
        testID="community-links-upstream"
      >
        Upstream
      </Button>
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  row: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 0,
  },
}));
