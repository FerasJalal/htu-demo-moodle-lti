<?php
require(__DIR__ . '/../../config.php');
require_once(__DIR__ . '/classes/helper.php');

$courseid = required_param('id', PARAM_INT);
$course = get_course($courseid);
require_login($course);
$context = context_course::instance($courseid);
require_capability('local/rennixtutor:use', $context);

$PAGE->set_url(new moodle_url('/local/rennixtutor/coursechat.php', ['id' => $courseid]));
$PAGE->set_context($context);
$PAGE->set_pagelayout('report');
$PAGE->set_title(get_string('coursetutorlink', 'local_rennixtutorbot') . ': ' . $course->shortname);
$PAGE->set_heading($course->fullname);

echo $OUTPUT->header();
?>
<style>
#rxt-log{max-width:760px;margin:0 auto 12px;min-height:300px;}
.rxt-msg{margin-bottom:10px;padding:10px 12px;border-radius:8px;max-width:80%;white-space:pre-wrap;}
.rxt-msg.user{background:#d6293e;color:#fff;margin-left:auto;}
.rxt-msg.assistant{background:#eef1f4;color:#0b1220;}
#rxt-form{display:flex;gap:8px;max-width:760px;margin:0 auto;}
#rxt-input{flex:1;padding:10px;border:1px solid #ccc;border-radius:6px;font-size:14px;}
#rxt-form button{padding:10px 18px;border:none;border-radius:6px;background:#d6293e;color:#fff;cursor:pointer;}
#rxt-form button:disabled{opacity:0.5;cursor:default;}
</style>
<div id="rxt-log"></div>
<form id="rxt-form">
  <input id="rxt-input" type="text" placeholder="Ask the Course Tutor..." autocomplete="off">
  <button type="submit">Send</button>
</form>
<script>
(function(){
  var COURSEID = <?php echo (int) $courseid; ?>;
  var SESSKEY = <?php echo json_encode(sesskey()); ?>;
  var history = [];

  function append(role, text) {
    var log = document.getElementById('rxt-log');
    var div = document.createElement('div');
    div.className = 'rxt-msg ' + role;
    div.textContent = text;
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
        courseid: COURSEID, message: msg, sesskey: SESSKEY, history: JSON.stringify(history.slice(-6))
      })
    }).then(function(r){ return r.json(); }).then(function(data){
      btn.disabled = false;
      if (data.error) { append('assistant', 'Sorry: ' + data.error); return; }
      append('assistant', data.reply);
      history.push({role:'user', content: msg});
      history.push({role:'assistant', content: data.reply});
    }).catch(function(){ btn.disabled = false; append('assistant', 'Sorry, something went wrong.'); });
  });
})();
</script>
<?php
echo $OUTPUT->footer();
