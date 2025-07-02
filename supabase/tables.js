import { supabase } from "../utils/SupabaseClient.js";
import fs from "fs";
import path from "path";

export async function checkEmbaddingExists(url) {
  try {
    console.log("Checking for existing embedding for URL:", url);
    const { data, error } = await supabase
      .from("ms_text_info")
      .select("*")
      .eq("url", url);

    console.log("Existing embedding data:", data);

    if (error) {
      console.log("Supabase Slug Checking Internal Error: ", error);
      return null;
    }

    if (!data || data.length === 0) {
      console.log("No existing embedding found for URL:", url);
      return null;
    }

    console.log("Found existing embedding for URL:", url);
    return data;
  } catch (error) {
    console.log("Supabase Slug Checking Error: ", error);
    return null;
  }
}

export async function storeEmbadding(supabaseInput) {
  const maxRetries = 10;
  const baseDelay = 1000; // 1 second

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase
        .from("ms_documents")
        .insert(supabaseInput);

      if (error) {
        console.log(`Supabase Error (Attempt ${attempt}/${maxRetries}):`, error);
        
        // If it's a timeout error and we haven't reached max retries, wait and retry
        if (error.code === '57014' && attempt < maxRetries) {
          const delay = 1000
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }

      return data;
    } catch (error) {
      if (attempt === maxRetries) {
        console.log("Supabase Calling Error (Final attempt):", error);
        throw error;
      }
      // For other errors, continue with retry
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`Retrying in ${delay}ms due to error:`, error.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

export async function storeTextInfo(textInfo) {
  try {
    const textObject = {
      // content: textInfo.content ?? "",
      slug: textInfo.slug,
      url: textInfo.url,
    };

    const { data, error } = await supabase
      .from("ms_text_info")
      .insert(textObject);

    if (error) {
      console.log("Supabase Text Info storing Error: ", error);
    }
  } catch (error) {
    console.log("Supabase Text Info Error: ", error);
  }
}

export async function checkSlug(slug) {
  try {
    const { data, error } = await supabase
      .from("ms_text_info")
      .select("*")
      .eq("slug", slug);

    if (error) {
      console.log("Supabase Slug Checking Internal Error: ", error);
    }

    // console.log("slug Exist: ", data);

    return data;
  } catch (error) {
    console.log("Supabase Slug Checking Error: ", error);
  }
}

export async function updateTextInfo(oldSlug, newSlug) {
  try {
    const { data, error } = await supabase
      .from("ms_text_info")
      .update({ slug: newSlug })
      .eq("slug", oldSlug);
    if (error) {
      console.log("Supabase Slug Checking Internal Error: ", error);
    }
  } catch (error) {
    console.log("Supabase Slug Checking Error: ", error);
  }
}

export async function checkEmbadding(embadding, slug) {
  const maxRetries = 15; // 15 attempts
  const retryDelay = 3000; // Consistent 3 second delay
  const matchCount = 2; // 2 matches for faster query
  const timeout = 15000; // 15 second timeout

  let attempt = 1;
  while (true) {
    try {
      // First try with a smaller subset of data
      const { data, error } = await supabase.rpc("match_documents_by_slug", {
        match_count: matchCount,
        query_embedding: embadding,
        slug_search: slug,
      }, {
        timeout: timeout
      });

      if (error) {
        console.error(`Supabase Embedding Error (Attempt ${attempt}/${maxRetries}):`, error);
        // If it's a timeout error and we haven't reached max retries
        if (error.code === '57014' && attempt < maxRetries) {
          console.log(`Timeout occurred, retrying in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          // Try fallback query with even more reduced parameters
          try {
            const fallbackResult = await supabase.rpc("match_documents_by_slug", {
              match_count: 1, // Try with just 1 match
              query_embedding: embadding,
              slug_search: slug,
            }, {
              timeout: timeout / 2 // Half the timeout for fallback
            });
            if (fallbackResult.error) {
              throw fallbackResult.error;
            }
            return fallbackResult.data;
          } catch (fallbackError) {
            console.error('Fallback query also failed:', fallbackError);
            attempt++;
            continue; // Continue to next retry if fallback fails
          }
        }
        throw new Error(`Supabase RPC error: ${error.message} (Code: ${error.code})`);
      }
      if (!data) {
        throw new Error('No data returned from Supabase RPC call');
      }
      return data;
    } catch (error) {
      if (attempt === maxRetries) {
        console.error("Final embedding check error:", error);
        // Try one last time with minimal parameters
        try {
          const lastResortResult = await supabase.rpc("match_documents_by_slug", {
            match_count: 1,
            query_embedding: embadding,
            slug_search: slug,
          }, {
            timeout: 5000 // 5 second timeout for last resort
          });
          if (lastResortResult.error) {
            throw lastResortResult.error;
          }
          return lastResortResult.data;
        } catch (lastResortError) {
          console.error('Last resort query failed:', lastResortError);
          // Instead of throwing, wait 2 minutes and then keep retrying indefinitely
          console.error(`Search operation failed after ${maxRetries} attempts. Waiting 2 minutes before retrying indefinitely...`);
          await new Promise(resolve => setTimeout(resolve, 120000)); // Wait 2 minutes
          attempt = maxRetries + 1; // Ensure we don't hit this block again
          continue; // Go back to the start of the loop and keep retrying
        }
      }
      if (attempt < maxRetries) {
        console.log(`Retrying in ${retryDelay}ms due to error:`, error.message);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        attempt++;
      } else if (attempt > maxRetries) {
        // After 15 attempts, always wait 2 minutes before retrying
        console.log(`Retrying after 2 minutes due to persistent error:`, error.message);
        await new Promise(resolve => setTimeout(resolve, 120000));
      }
    }
  }
}

export async function deleteEmbeddingsBySlug(slug) {
  try {
    const { data, error } = await supabase
      .from("ms_documents")
      .delete()
      .eq("slug", slug);

    console.log(slug, data);

    if (error) {
      console.log("Error deleting embeddings: ", error);
    } else {
      console.log("Deleted existing embeddings for slug:", slug);
    }

    return data;
  } catch (error) {
    console.log("Supabase Deletion Error: ", error);
  }
}

export async function fetchTest(id) {
  try {
    const { data, error } = await supabase
      .from("agents")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;

    return data;
  } catch (error) {
    console.error("Error fetching test:", error);
    throw error;
  }
}

export async function fetchSuites() {
  const { data, error } = await supabase
    .from("suits")
    .select("id, name, testIds, scheduleStart, scheduleEnd")
    .order("name");

  if (error) {
    console.error("Error fetching suites:", error);
    throw error;
  }

  return data || [];
}

export async function updateSuiteSchedule(suiteId, startTime, endTime) {
  const { data, error } = await supabase
    .from("suits")
    .update({ scheduleStart: startTime, scheduleEnd: endTime })
    .eq("id", suiteId);

  if (error) {
    console.error("Error updating suite schedule:", error);
    throw error;
  }

  return data;
}

export const fetchScheduledTests = async (startTime, endTime) => {
  const { data, error } = await supabase
    .from("scheduled_tests")
    .select("scheduled_time")
    .gte("scheduled_time", startTime)
    .lt("scheduled_time", endTime)
    .order("scheduled_time", { ascending: true });

  if (error) {
    console.error("Error fetching scheduled tests:", error);
    throw error;
  }

  return data || [];
};

export async function insertScheduledTest(suiteId, scheduledTime) {
  const { data, error } = await supabase
    .from("scheduled_tests")
    .insert({ suite_id: suiteId, scheduled_time: scheduledTime });

  if (error) {
    console.error("Error inserting scheduled test:", error);
    throw error;
  }

  return data;
}

export async function clearScheduledTests() {
  const { data, error } = await supabase
    .from("scheduled_tests")
    .delete()
    .not("id", "is", null);

  if (error) {
    console.error("Error clearing scheduled tests:", error);
    throw error;
  }

  console.log("Cleared scheduled tests");
  return data;
}

export async function updateTest(id, updateData) {
  console.log("------------------------------------", id, updateData);
  try {
    const { data, error } = await supabase
      .from("agents")
      .update({ steps: updateData })
      .eq("id", id)
      .select();
    console.log(data);
    if (error) throw error;

    return data;
  } catch (error) {
    console.error("Error updating test:", error);
    throw error; // Re-throw the error so it can be handled by the caller
  }
}

export async function updateCache(id, cache) {
  // console.log("------------------------------------", id, updateData);
  try {
    const { data, error } = await supabase
      .from("agents")
      .update({ steps: updateData })
      .eq("id", id)
      .select();
    console.log(data);
    if (error) throw error;

    return data;
  } catch (error) {
    console.error("Error updating test:", error);
    throw error; // Re-throw the error so it can be handled by the caller
  }
}

export async function storeTest(newTestName, newTestUrl, email) {
  try {
    const { data, error } = await supabase
      .from("agents")
      .insert({
        name: newTestName,
        url: newTestUrl,
        email: email,
      })
      .select("id")
      .single();

    if (error) throw error;

    return data;
  } catch (error) {
    console.error("Error creating new test:", error);
    // Handle the error (e.g., show an error message to the user)
  }
}

export async function createStreamRun(runId) {
  try {
    const { data, error } = await supabase
      .from("stream_run")
      .insert({
        run_id: runId,
        logs: [],
        screenshot: null
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Error creating stream run:", error);
    throw error;
  }
}

export async function insertRunHistory(email, testName, runId) {
  try {
    // Fetch user's current workspace
    const { data: userDetails, error: userError } = await supabase
      .from("user_details")
      .select("current_workspace")
      .eq("email", email)
      .single();

    if (userError || !userDetails) {
      throw userError || new Error("User not found");
    }

    // Fetch workspace id by name
    const { data: workspace, error: wsError } = await supabase
      .from("workspaces")
      .select("id")
      .eq("name", userDetails.current_workspace)
      .eq("email", email)
      .single();

    if (wsError || !workspace) {
      throw wsError || new Error("Workspace not found");
    }

    const { data, error } = await supabase
      .from("run_history")
      .insert({
        user_email: email,
        test_name: testName,
        status: "Running",
        started: new Date().toISOString(),
        run_id: runId,
        associated_workspaceid: workspace.id
      })
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error("Error inserting run history:", error);
    throw error;
  }
}

export async function updateRunHistory(
  id,
  status,
  cost
) {
  try {
    const { data, error } = await supabase
      .from("run_history")
      .update({
        status: status,
        cost: cost,
        ended: new Date().toISOString(),
      })
      .eq("run_id", id)
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error("Error updating run history:", error);
    throw error;
  }
}


export async function storeTestRun(testId, testName, status, data, runId) {
  const createdAt = new Date().toISOString();
  try {
    const { data: result, error } = await supabase
      .from("test_runs")
      .insert({
        run_id: runId,
        created_at: createdAt,
        test_id: testId,
        test_name: testName,
        status: status,
        data: data
      })
      .select();

    if (error) {
      console.error("Error storing test run:", error);
      throw error;
    }

    return result;
  } catch (error) {
    console.error("Error in storeTestRun:", error);
    throw error;
  }
}

export async function updateStreamRun(runId, updateData) {
  try {
    const { data, error } = await supabase
      .from("stream_run")
      .update(updateData)
      .eq("run_id", runId)
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Error updating stream run:", error);
    throw error;
  }
}

export async function getStreamRun(runId) {
  try {
    const { data, error } = await supabase
      .from("stream_run")
      .select("*")
      .eq("run_id", runId)
      .single();

    if (error) throw error;
    return data;
  } catch (error) {
    console.error("Error getting stream run:", error);
    throw error;
  }
}

/**
 * Uploads a file to the 'files' bucket in Supabase Storage.
 * @param {string} fileName - The name to use for the file in Supabase.
 * @param {Buffer|string} fileContent - The file content (Buffer or string).
 * @returns {Promise<string>} - The public URL of the uploaded file.
 */
export async function uploadFileToSupabase(fileName, fileContent) {
  try {
    const { data, error } = await supabase.storage
      .from("files")
      .upload(fileName, fileContent, {
        contentType: "application/octet-stream",
        upsert: false,
      });
    if (error) throw error;
    // Get public URL
    const { data: urlData } = supabase.storage.from("files").getPublicUrl(fileName);
    if (!urlData) throw new Error("Failed to get public URL");
    return urlData.publicUrl;
  } catch (error) {
    console.error("Error uploading file to Supabase:", error);
    throw error;
  }
}

/**
 * Downloads a file from the 'files' bucket in Supabase Storage and saves it to files_storage.
 * @param {string} fileName - The name of the file in Supabase.
 * @returns {Promise<string>} - The local path to the saved file.
 */
export async function downloadFileFromSupabase(fileName) {
  try {
    const { data, error } = await supabase.storage.from("files").download(fileName);
    if (error) throw error;
    // Ensure files_storage directory exists
    const storageDir = path.resolve("files_storage");
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir);
    }
    const localPath = path.join(storageDir, fileName);
    // Write file to local storage
    fs.writeFileSync(localPath, Buffer.from(await data.arrayBuffer()));
    return localPath;
  } catch (error) {
    console.error("Error downloading file from Supabase:", error);
    throw error;
  }
}
