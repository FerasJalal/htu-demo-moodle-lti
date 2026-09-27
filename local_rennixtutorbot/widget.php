<?php
require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/classes/helper.php');

$cmid = required_param('cmid', PARAM_INT);
$cm = get_coursemodule_from_id('', $cmid, 0, false, MUST_EXIST);
$course = get_course($cm->course);
require_login($course, false, $cm);
$context = context_course::instance($cm->course);
require_capability('local/rennixtutor:use', $context);

$PAGE->set_url(new moodle_url('/local/rennixtutor/widget.php', ['cmid' => $cmid]));
$PAGE->set_context($context);
$PAGE->set_pagelayout('embedded');
$PAGE->set_title('Ask AI');

echo $OUTPUT->header();
?>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;display:flex;flex-direction:column;height:100vh;background:#fafbfc;}
#rxt-log{flex:1;overflow-y:auto;padding:10px;}
.rxt-msg{margin-bottom:10px;padding:8px 10px;border-radius:8px;max-width:90%;white-space:pre-wrap;}
.rxt-msg.user{background:#d6293e;color:#fff;margin-left:auto;}
.rxt-msg.assistant{background:#eef1f4;color:#0b1220;}
.rxt-cite{display:block;margin-top:4px;font-size:11px;color:#666;}
#rxt-form{display:flex;gap:6px;padding:8px;border-top:1px solid #e2e8f0;background:#fff;}
#rxt-input{flex:1;padding:8px;border:1px solid #ccc;border-radius:6px;font-size:13px;}
#rxt-form button{padding:8px 14px;border:none;border-radius:6px;background:#d6293e;color:#fff;cursor:pointer;}
#rxt-form button:disabled{opacity:0.5;cursor:default;}
</style>
<div id="rxt-log"></div>
<form id="rxt-form">
  <input id="rxt-input" type="text" placeholder="Ask about this lecture..." autocomplete="off">
  <button type="submit">Send</button>
</form>
<script>
(function(){
  var CMID = <?php echo (int) $cmid; ?>;
  var SESSKEY = <?php echo json_encode(sesskey()); ?>;
  var position = null;
  var history = [];

  window.addEventListener('message', function(e){
    if (e.data && e.data.type === 'identify' && typeof e.data.position === 'number') {
      position = e.data.position;
    }
  });

  function append(role, text, citeStart) {
    var log = document.getElementById('rxt-log');
    var div = document.createElement('div');
    div.className = 'rxt-msg ' + role;
    div.textContent = text;
    if (citeStart !== undefined && citeStart !== null) {
      var m = Math.floor(citeStart / 60), s = Math.floor(citeStart % 60);
      var cite = document.createElement('span');
      cite.className = 'rxt-cite';
      cite.textContent = 'Around ' + m + ':' + String(s).padStart(2, '0') + ' in the video';
      div.appendChild(cite);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  document.getElementById('rxt-form').addEventListener('submit', function(ev){
    ev.preventDefault();
    var input = document.getElementById('rxt-input');
    var btn = ev.target.querySelector('button');
    var msg = input.value.trim();
    if (!msg) return;
    append('user', msg);
    input.value = '';
    btn.disabled = true;
    fetch('/local/rennixtutor/chat_ajax.php', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        cmid: CMID, message: msg, position: position === null ? '' : String(position),
        sesskey: SESSKEY, history: JSON.stringify(history.slice(-6))
      })
    }).then(function(r){ return r.json(); }).then(function(data){
      btn.disabled = false;
      if (data.error) { append('assistant', 'Sorry: ' + data.error); return; }
      append('assistant', data.reply, data.citeStart);
      history.push({role:'user', content: msg});
      history.push({role:'assistant', content: data.reply});
    }).catch(function(){ btn.disabled = false; append('assistant', 'Sorry, something went wrong.'); });
  });
})();
</script>
<?php
echo $OUTPUT->footer();
