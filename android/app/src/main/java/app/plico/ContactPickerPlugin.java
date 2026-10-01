package app.plico;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract.CommonDataKinds.Phone;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

// The system contacts app picks one phone number. Picking a data row (Phone, not Contacts) hands back a URI with a
// temporary read grant on that row, so name + number come without READ_CONTACTS. Email would need the permission: skipped.
@CapacitorPlugin(name = "ContactPicker")
public class ContactPickerPlugin extends Plugin {

  @PluginMethod
  public void pick(PluginCall call) {
    startActivityForResult(call, new Intent(Intent.ACTION_PICK, Phone.CONTENT_URI), "picked");
  }

  @ActivityCallback
  private void picked(PluginCall call, ActivityResult result) {
    Uri uri = result.getData() == null ? null : result.getData().getData();
    if (result.getResultCode() != Activity.RESULT_OK || uri == null) { call.resolve(); return; } // cancelled
    JSObject ret = new JSObject();
    try (Cursor c = getContext().getContentResolver().query(uri, new String[] { Phone.DISPLAY_NAME, Phone.NUMBER }, null, null, null)) {
      if (c != null && c.moveToFirst()) {
        ret.put("name", c.getString(0));
        ret.put("phones", new JSArray().put(c.getString(1))); // same shape as iOS, which hands over every number
      }
    } catch (Exception e) {
      call.reject("Couldn't read that contact", e);
      return;
    }
    call.resolve(ret);
  }
}
