<?php
defined('MOODLE_INTERNAL') || die();

// Calls OpenAI directly from Moodle using an admin-configured API key -- no
// external server involved. Each lecture's full transcript (a handful of
// short excerpts, not a large document) is sent as context on every
// question, which is simpler than running a vector search and is cheap
// enough at this content size.
class local_rennixtutorbot_helper {

    public static function detect_language(string $text): string {
        return preg_match('/[\x{0600}-\x{06FF}]/u', $text) ? 'ar' : 'en';
    }

    public static function format_timestamp(?float $seconds): ?string {
        if ($seconds === null) {
            return null;
        }
        $m = (int) floor($seconds / 60);
        $s = (int) floor($seconds) % 60;
        return $m . ':' . str_pad((string) $s, 2, '0', STR_PAD_LEFT);
    }

    /** ['title' => string, 'excerpts' => [{text,start,end}, ...]] or null. */
    public static function get_transcript(int $cmid): ?array {
        global $DB;
        $row = $DB->get_record('local_rennixtutorbot_transcript', ['cmid' => $cmid]);
        if (!$row) {
            return null;
        }
        return ['title' => $row->lecturetitle, 'excerpts' => json_decode($row->content, true) ?: []];
    }

    public static function call_openai(array $messages): string {
        global $CFG;
        require_once($CFG->libdir . '/filelib.php');

        $apikey = get_config('local_rennixtutorbot', 'apikey');
        $model = get_config('local_rennixtutorbot', 'model') ?: 'gpt-4o-mini';
        if (empty($apikey)) {
            throw new moodle_exception('AI is not configured yet -- ask an administrator to set the OpenAI API key in Site administration > Plugins > Rennix Tutor.');
        }

        $curl = new \curl();
        $curl->setHeader(['Content-Type: application/json', 'Authorization: Bearer ' . $apikey]);
        $response = $curl->post('https://api.openai.com/v1/chat/completions', json_encode([
            'model' => $model,
            'messages' => $messages,
            'temperature' => 0.3,
        ]), ['CURLOPT_TIMEOUT' => 30, 'CURLOPT_CONNECTTIMEOUT' => 10]);

        $data = json_decode($response, true);
        if (!isset($data['choices'][0]['message']['content'])) {
            $msg = $data['error']['message'] ?? 'The AI provider did not return a usable response.';
            throw new moodle_exception('AI request failed: ' . $msg);
        }
        return $data['choices'][0]['message']['content'];
    }

    /** [cleanedtext, citestart|null, citeend|null]. */
    public static function extract_citation(string $text): array {
        if (preg_match('/\[\[CITE:(\d+)-(\d+)\]\]/', $text, $m)) {
            $clean = trim(str_replace($m[0], '', $text));
            return [$clean, (int) $m[1], (int) $m[2]];
        }
        return [$text, null, null];
    }

    /** True if allowed, false if the user should be told to slow down. */
    public static function check_rate_limit(int $userid): bool {
        $cache = \cache::make('local_rennixtutorbot', 'ratelimit');
        $key = 'u' . $userid;
        $count = (int) ($cache->get($key) ?: 0);
        if ($count >= 15) {
            return false;
        }
        $cache->set($key, $count + 1);
        return true;
    }

    public static function build_lecture_prompt(string $title, array $excerpts, string $languagename, ?float $position): string {
        $hastimestamps = false;
        $context = '';
        $currentmarked = false;
        $i = 0;
        foreach ($excerpts as $e) {
            $i++;
            $start = $e['start'] ?? null;
            $end = $e['end'] ?? null;
            $iscurrent = $position !== null && $start !== null && $end !== null && $position >= $start && $position < $end;
            if ($iscurrent) {
                $currentmarked = true;
            }
            if ($start !== null) {
                $hastimestamps = true;
                $label = "[Excerpt $i, " . self::format_timestamp($start) . '–' . self::format_timestamp($end) .
                    ($iscurrent ? ' — WHERE THE STUDENT CURRENTLY IS' : '') . ']';
            } else {
                $label = "[Excerpt $i]";
            }
            $context .= $label . "\n" . $e['text'] . "\n\n";
        }

        $prompt = "You are a course tutor bot for the lecture \"$title\". " .
            "Answer the student's question using ONLY the lecture excerpts below. " .
            "The lecture material may be in Arabic even though the student's question is in $languagename. " .
            "You MUST reply in $languagename, regardless of what language the excerpts are in. ";

        if ($hastimestamps) {
            $prompt .= "Each excerpt is labeled with the timestamp range (minutes:seconds) it was spoken at in the video. " .
                "When the student asks about a specific time or \"what happened at/around minute X\", find the excerpt whose " .
                "timestamp range covers that time and answer from it, citing the timestamp. If no excerpt covers the requested " .
                "time, say so. ";
            if ($currentmarked) {
                $prompt .= "The student did not name a specific time -- one excerpt is marked \"WHERE THE STUDENT CURRENTLY IS\" " .
                    "because that's their live position in the video. If their question is vague or clearly about \"this\"/\"that\"/" .
                    "what's on screen right now, ground your answer in that excerpt and cite its timestamp. If the question is " .
                    "clearly about something else, answer that instead.\n\n";
            } else {
                $prompt .= "\n\n";
            }
        }

        $prompt .= "Mention the timestamp naturally in your answer's own language. If the excerpts don't contain the answer, " .
            "say you don't have that information in this lecture, don't make anything up.\n\n" . $context;

        if ($hastimestamps) {
            $prompt .= "\nAfter your full answer, on its own new line, output exactly this marker with the RAW SECOND values " .
                "(not minutes:seconds) of the excerpt range you grounded your answer in, e.g. [[CITE:135-289]]. Use this literal " .
                "format always, in English, never translated or described -- it will be stripped before the student sees your reply.";
        }
        return $prompt;
    }

    public static function build_course_prompt(int $courseid, string $languagename): string {
        global $DB;
        $guidelines = get_config('local_rennixtutorbot', 'guidelines_' . $courseid);
        if (empty($guidelines)) {
            $guidelines = 'A single communication channel is used for all students and instructors. Learning materials are ' .
                'released weekly. Each module includes pre-recorded lectures and accompanying reading materials. Students are ' .
                'expected to review materials before each practical session. A short knowledge-check quiz is available at the ' .
                'end of each module.';
        }
        $titles = $DB->get_records('local_rennixtutorbot_transcript', ['courseid' => $courseid], 'cmid ASC', 'id, lecturetitle');
        $materialindex = implode("\n", array_map(fn($t) => '- ' . $t->lecturetitle, $titles));

        return "You are the AI tutor for this course.\n\n" .
            "You are a formative learning aid, not an answer key. Ground every factual answer in the course guidelines or " .
            "material index below; if a question needs specific lecture content, tell the student which lecture to open so the " .
            "lecture-scoped Ask AI (which has the transcript) can help.\n\n" .
            "Course guidelines:\n$guidelines\n\n" .
            "Course material index (titles only; not evidence):\n$materialindex\n\n" .
            "Rules:\n" .
            "- Never answer a factual question from your own general/outside training knowledge. If the guidelines and material " .
            "index don't cover it, say so honestly.\n" .
            "- Keep answers concise.\n" .
            "- Never write a student's assignment submission for them -- explain concepts, don't produce final answers to graded " .
            "work.\n" .
            "- Respond ONLY in the language of the student's most recent message ($languagename).\n";
    }

    /** ['in_video' => [...], 'end_of_video' => [...]], each popup shaped for the client JS. */
    public static function get_popups(int $cmid): array {
        global $DB;
        $rows = $DB->get_records('local_rennixtutorbot_popup', ['cmid' => $cmid], 'timestamp ASC');
        $out = ['in_video' => [], 'end_of_video' => []];
        foreach ($rows as $row) {
            $shaped = [
                'id' => (int) $row->id,
                'timestamp' => (float) $row->timestamp,
                'question' => $row->question,
                'options' => json_decode($row->options, true) ?: [],
            ];
            $bucket = $row->placement === 'end_of_video' ? 'end_of_video' : 'in_video';
            $out[$bucket][] = $shaped;
        }
        return $out;
    }

    /** ['correct' => bool, 'explanation' => string|null] or null if the popup id is invalid. */
    public static function record_response(int $popupid, int $userid, int $selectedindex): ?array {
        global $DB;
        $popup = $DB->get_record('local_rennixtutorbot_popup', ['id' => $popupid]);
        if (!$popup) {
            return null;
        }
        $correct = $selectedindex === (int) $popup->correctindex;
        $DB->insert_record('local_rennixtutorbot_response', (object) [
            'popupid' => $popupid, 'userid' => $userid,
            'status' => $correct ? 'correct' : 'incorrect', 'timecreated' => time(),
        ]);
        return ['correct' => $correct, 'explanation' => $popup->explanation ?: null];
    }

    public static function record_dropped(int $popupid, int $userid): void {
        global $DB;
        if (!$DB->record_exists('local_rennixtutorbot_popup', ['id' => $popupid])) {
            return;
        }
        $DB->insert_record('local_rennixtutorbot_response', (object) [
            'popupid' => $popupid, 'userid' => $userid, 'status' => 'dropped', 'timecreated' => time(),
        ]);
    }
}
