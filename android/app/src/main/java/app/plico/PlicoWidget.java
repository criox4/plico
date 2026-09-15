package app.plico;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;
import org.json.JSONArray;
import org.json.JSONObject;

/** Home-screen balance: the summary the app keeps in Capacitor Preferences ("CapacitorStorage" / "widget"). */
public class PlicoWidget extends AppWidgetProvider {
  private static final int POS = 0xFF0B7A56, NEG = 0xFFC8374A, INK = 0xFF17171C;
  private static final int[][] ROWS = {
    { R.id.row1, R.id.row1_name, R.id.row1_amount },
    { R.id.row2, R.id.row2_name, R.id.row2_amount },
    { R.id.row3, R.id.row3_name, R.id.row3_amount },
  };

  @Override
  public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
    RemoteViews v = render(context);
    for (int id : ids) manager.updateAppWidget(id, v);
  }

  /** Called when the app pauses, so the widget shows what you just saw. */
  public static void refreshAll(Context context) {
    AppWidgetManager m = AppWidgetManager.getInstance(context);
    int[] ids = m.getAppWidgetIds(new ComponentName(context, PlicoWidget.class));
    if (ids.length > 0) new PlicoWidget().onUpdate(context, m, ids);
  }

  private static RemoteViews render(Context context) {
    RemoteViews v = new RemoteViews(context.getPackageName(), R.layout.widget_balance);
    Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    v.setOnClickPendingIntent(R.id.widget_root, PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
    for (int[] r : ROWS) v.setViewVisibility(r[0], android.view.View.GONE);
    try {
      String raw = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE).getString("widget", null);
      JSONObject d = raw == null ? null : new JSONObject(raw);
      if (d == null || !d.optBoolean("signedIn")) {
        v.setTextViewText(R.id.widget_title, "Plico");
        v.setTextViewText(R.id.widget_amount, "Open to sign in");
        v.setTextColor(R.id.widget_amount, INK);
        return v;
      }
      String tone = d.optString("tone");
      v.setTextViewText(R.id.widget_title, d.optString("title"));
      v.setTextViewText(R.id.widget_amount, d.optString("amount"));
      v.setTextColor(R.id.widget_amount, "pos".equals(tone) ? POS : "neg".equals(tone) ? NEG : INK);
      JSONArray groups = d.optJSONArray("groups");
      for (int i = 0; groups != null && i < Math.min(groups.length(), ROWS.length); i++) {
        JSONObject g = groups.getJSONObject(i);
        String emoji = g.optString("emoji");
        v.setViewVisibility(ROWS[i][0], android.view.View.VISIBLE);
        v.setTextViewText(ROWS[i][1], (emoji.isEmpty() ? "" : emoji + "  ") + g.optString("name"));
        v.setTextViewText(ROWS[i][2], g.optString("amount"));
        v.setTextColor(ROWS[i][2], "pos".equals(g.optString("tone")) ? POS : NEG);
      }
    } catch (Exception e) {
      v.setTextViewText(R.id.widget_title, "Plico");
      v.setTextViewText(R.id.widget_amount, "Open Plico");
    }
    return v;
  }
}
