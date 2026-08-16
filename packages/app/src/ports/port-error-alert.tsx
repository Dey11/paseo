import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function PortErrorAlert(props: {
  message: string;
  onDismiss(): void;
  onRetry?: () => void;
  testID: string;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <Alert testID={props.testID} variant="error" title={props.title} description={props.message}>
      {props.onRetry ? (
        <Button size="xs" variant="secondary" onPress={props.onRetry}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" onPress={props.onDismiss}>
        {t("common.actions.dismiss")}
      </Button>
    </Alert>
  );
}
