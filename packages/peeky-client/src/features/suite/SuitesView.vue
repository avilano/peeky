<script lang="ts" setup>
import BaseSplitPane from '../BaseSplitPane.vue'
import BaseInput from '../BaseInput.vue'
import SuiteItem from './SuiteItem.vue'
import { SearchIcon } from '@zhuowenli/vue-feather-icons'
import { computed, defineProps, ref } from 'vue'

const props = defineProps({
  suites: {
    type: Array,
    required: true,
  },

  run: {
    type: Object,
    required: true,
  },
})

const searchText = ref('')
const searchReg = computed(() => searchText.value ? new RegExp(searchText.value, 'gi') : null)
</script>

<template>
  <BaseSplitPane
    :default-split="25"
    :min="5"
    :max="70"
    save-id="peeky-run-test-file-view"
    class="h-full"
  >
    <template #first>
      <div class="h-full flex flex-col divide-y divide-gray-100 dark:divide-gray-800">
        <slot name="toolbar" />

        <div class="flex-none">
          <BaseInput
            v-model="searchText"
            size="md"
            placeholder="Filter tests..."
            class="h-10"
          >
            <template #after>
              <SearchIcon class="mx-3 text-gray-500" />
            </template>
          </BaseInput>
        </div>

        <div class="flex-1 overflow-y-auto">
          <SuiteItem
            v-for="suite of suites"
            :key="suite.id"
            :suite="suite"
            :run="run"
            :search-reg="searchReg"
            :depth="0"
          />

          <div
            v-if="!suites.length"
            class="my-12 flex items-center justify-center"
          >
            <div class="bg-gray-50 text-gray-600 dark:bg-gray-900 dark:text-gray-400 text-center px-4 py-3 rounded">
              😿️ No test suites found
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #last>
      <router-view />
    </template>
  </BaseSplitPane>
</template>
