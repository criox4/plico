package app.plico;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;
import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;

// Google sign-in (SocialLogin plugin) hands its authorization result back through this activity.
public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    registerPlugin(ContactPickerPlugin.class); // local plugins must be registered before the bridge starts
    super.onCreate(savedInstanceState);
  }

  @Override
  public void onPause() {
    super.onPause();
    PlicoWidget.refreshAll(this); // the home-screen widget shows what you just saw
  }

  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
      PluginHandle handle = getBridge().getPlugin("SocialLogin");
      if (handle == null) { Log.i("Google Activity Result", "SocialLogin handle is null"); return; }
      Plugin plugin = handle.getInstance();
      if (!(plugin instanceof SocialLoginPlugin)) { Log.i("Google Activity Result", "not SocialLoginPlugin"); return; }
      ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
    }
  }

  public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}
}
